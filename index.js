const express = require("express");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const axios = require("axios");
const cors = require("cors");
const AWS = require("aws-sdk");
dotenv.config();
const MongoClient = require("mongodb").MongoClient;
const tmi = require("tmi.js");
const { ObjectId } = require("bson");
const app = express();
app.use(cors());
app.use(express.json());
const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*" },
  allowEIO3: true,
});
const uri = process.env.MONGODBURI;
const youtubeAPIKey = process.env.YOUTUBE_API_KEY;
const key = process.env.JWT_KEY;
const secretJwt = Buffer.from(key, "base64");

const Polly = new AWS.Polly({
  accessKeyId: process.env.AWS_KEY,
  secretAccessKey: process.env.AWS_SECRET,
  region: "eu-west-3",
});
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  connectTimeoutMS: 30000,
  keepAlive: 1,
});
const chatClientAdmin = new tmi.Client({
  options: { debug: false },
  connection: {
    reconnect: true,
    secure: true,
  },
  identity: {
    username: "cenoroid",
    password: process.env.TWITCH_CHAT_PASSWORD, //when no work https://twitchapps.com/tmi/
  },
  channels: ["cenoroid"],
});
let requestsArray = [];
let goalsArray = [];
let redemptionsArray = [];
let timerInterval;
let timer;
let timerRunning = false;

let database;
chatClientAdmin.connect(() => {
  console.log("chat is here");
});
client.connect(() => {
  clientConnected = true;
  database = client.db("botoroid");
  console.log("database connected");
  initRequests();
  initGoals();
  initRedemptions();
});

function verifyAndDecode(header) {
  try {
    return jwt.verify(header, secretJwt, { algorithms: ["HS256"] });
  } catch (e) {
    return console.log(e);
  }
}

io.on("connection", (socket) => {
  socket.on("join", (data) => {
    socket.join(data.name.toLowerCase());
    socket.version = data.version;
    console.log("welcome " + data.name);
    if (data === "greenbar") {
      getGreenBarData();
    }
    if (data.name === "streamer") {
      getGreenBarData();
      socket.emit("getrequests", requestsArray);
      socket.emit("getgoals", goalsArray);
      socket.emit("getredemptions", redemptionsArray);
      (async () => {
        let logs = await getLogs();
        socket.emit("geteventlog", logs);
      })();
      (async () => {
        await getSettings().then((item) => {
          socket.emit("getsettings", item);
        });
      })();
      socket.emit("starttimer", timer, timerRunning);
    }
  });
  socket.on("disconnecting", () => {
    let name = Array.from(socket.rooms)[1];
    if (name) {
      console.log(name + " is gone");
    }
  });
  socket.on("get", (data) => {
    getData(data, socket, false);
  });
  socket.on("getrequests", () => {
    socket.emit("getrequests", requestsArray);
  });
  socket.on("getgoals", () => {
    socket.emit("getgoals", goalsArray);
  });
  socket.on("getredemptions", () => {
    socket.emit("getredemptions", redemptionsArray);
  });
  socket.on("updatepref", (data) => {
    updatePref(data, socket);
  });

  socket.on("swaprequests", (data) => {
    let startingEntry = requestsArray[data.start - 1];
    if (data.start < data.end) {
      data.end = data.end - 1;
    }
    requestsArray.splice(data.start - 1, 1);
    requestsArray.splice(data.end, 0, startingEntry);
    for (let index = 0; index < requestsArray.length; index++) {
      requestsArray[index].id = index + 1;
    }
    io.sockets.emit("getrequests", requestsArray);
  });
  socket.on("gettimer", () => {
    socket.emit("starttimer", timer, timerRunning);
  });

  socket.on("deleterequest", (data) => {
    requestsArray.splice(data.id - 1, 1);
    for (let index = 0; index < requestsArray.length; index++) {
      requestsArray[index].id = index + 1;
    }
    deleteRequest(data.lookup);
    io.sockets.emit("getrequests", requestsArray);
  });
  socket.on("redemption", async (data) => {
    console.log(redemptionsArray);
    let redemption = redemptionsArray[data.id - 1];

    data.subtype = redemption.type;
    data.value = redemption.cost;
    data.type = "redemption";
    let text = data.username + " has redeemed " + data.subtype;
    Polly.synthesizeSpeech(
      {
        Text: text,
        TextType: "text",
        VoiceId: "Brian",
        OutputFormat: "mp3",
      },
      (err, res) => {
        if (err) {
          console.log(err);
        } else if (res) {
          io.sockets.emit("event", {
            tts: res.AudioStream,
            text,
          });
        }
      }
    );

    data.lookup = Math.random() * 1000000;
    if (
      data.subtype === "video request" ||
      data.subtype === "short video request"
    ) {
      linkCheck(data);
    }
    if (data.subtype === "game request") {
      requestsArray.push({
        name: data.username,
        subtype: data.subtype,
        message: data.message,
        id: requestsArray.length + 1,
        lookup: data.lookup,
      });
      io.sockets.emit("getrequests", requestsArray);
      addRequest(data);
      newLog(data);
    }
    if (data.subtype === "vip for a year") {
      //data=user
      updateVip(data);
    } else {
      newLog(data);
    }
  });
  socket.on("starttimer", () => {
    if (requestsArray.length > 0) {
      timerLookup = requestsArray[0].lookup;
      if (requestsArray[0].subtype === "short video request") {
        timer = 600;
      } else timer = 1800;
      timerInterval = setInterval(function () {
        requestTimer(timerLookup);
      }, 1000);
      timerRunning = true;
      io.sockets.emit("starttimer", timer, timerRunning);
    }
  });
  socket.on("pausetimer", () => {
    if (timerRunning) {
      timerRunning = false;
      clearInterval(timerInterval);
    } else {
      timerRunning = true;
      timerInterval = setInterval(function () {
        requestTimer(timerLookup);
      }, 1000);
    }
    io.sockets.emit("pausetimer");
  });
  socket.on("stoptimer", () => {
    timer = 0;
    io.sockets.emit("stoptimer");
  });
  socket.on("updatecurrency", (data) => {
    updateCurrency(data);
  });
  socket.on("refund", async (data) => {
    updateCurrency({ username: data.user, value: data.event.cost });

    if (data.event.type) deleteEvent(data._id);
    if (data.event.type === "goal") {
      let result = goalsArray.find(({ goal }) => goal === data.event.subtype);
      result.current = result.current - data.event.cost;
      updateGoal({ goal: data.event.subtype, value: -data.event.cost });
      io.sockets.emit("getgoals", goalsArray);
    }
    let logs = await getLogs();
    io.sockets.emit("geteventlog", logs);
  });
  socket.on("goalupdate", (data) => {
    let text =
      data.username +
      " has added " +
      data.value +
      " to " +
      goalsArray[data.id].goal;
    Polly.synthesizeSpeech(
      {
        Text: text,
        TextType: "text",
        VoiceId: "Brian",
        OutputFormat: "mp3",
      },
      (err, res) => {
        if (err) {
          console.log(err);
        } else if (res) {
          io.sockets.emit("event", {
            tts: res.AudioStream,
            text,
          });
        }
      }
    );
    goalsArray[data.id].current = goalsArray[data.id].current + data.value;
    updateGoal({
      goal: goalsArray[data.id].goal,
      value: data.value,
      username: data.username,
    });
    data.type = "goal";
    data.subtype = goalsArray[data.id].goal;
    data.message = "";
    newLog(data);
    updateCurrency({ username: data.username, value: -data.value });
    io.sockets.emit("getgoals", goalsArray);
  });
  socket.on("greenbartitle", (data) => {
    greenBarTitleArray.push(data);
    updateGreenBarTitle();
  });
  socket.on("money", (data) => {
    updateCurrency({ username: data.username, value: Math.floor(data.value) });
    io.to(data.username.toLowerCase()).emit(
      "updatecurrency",
      Math.floor(data.value)
    );
    updateGreenBarAmount(data.value);
  });
  socket.on("weeklyreset", () => {
    resetGreenBar(); //getgreenbardata and reset
    resetGoals(); //get goals and reset
  });

  socket.on("updategoals", async () => {
    await initGoals().then(() => {
      io.sockets.emit("getgoals", goalsArray);
    });
  });
  socket.on("updateredemptions", async () => {
    await initRedemptions().then(() => {
      io.sockets.emit("getredemptions", redemptionsArray);
    });
  });
  socket.on("updatesettings", (data) => {
    updateSettings(data);
  });
  socket.on("savegoals", (data) => {
    updateGoals(data);
  });
  socket.on("deletegoal", (data) => {
    deleteGoal(data);
  });
  socket.on("saveredemptions", (data) => {
    updateRedemptions(data);
  });
  socket.on("deleteredemption", (data) => {
    deleteRedemption(data);
  });
  socket.on("reset", (data) => {
    if (data.goal === "pinata") {
      resetGreenBar(1);
    }
    resetGoal(data.goal);
  });
  socket.on("getsettings", async () => {
    let settings = await getSettings();
    socket.emit("getsettings", settings);
  });
});
async function updateSettings(data) {
  await Object.keys(data).forEach((type) => {
    Object.entries(data[type]).forEach(async (field) => {
      database.collection("settings").updateOne(
        { type },
        {
          $set: {
            [field[0]]: field[1],
          },
        }
      );
    });
  });
  setTimeout(async () => {
    let settings = await getSettings();
    io.sockets.emit("getsettings", settings);
  }, 1000);
}
async function updateGoals(data) {
  Object.keys(data).forEach((goal) => {
    if (goal === "new goal") {
      database.collection("goals").insertOne(data[goal]);
    } else
      Object.entries(data[goal]).forEach((field) => {
        database.collection("goals").updateOne(
          {
            goal,
          },
          {
            $set: {
              [field[0]]: field[1],
            },
          },
          { upsert: true }
        );
      });
  });
  setTimeout(async () => {
    let goals = await initGoals();
    io.sockets.emit("getgoals", goals);
  }, 1000);
}
async function deleteGoal(data) {
  await database.collection("goals").deleteOne({ goal: data.goal });
  (async () => {
    let goals = await initGoals();
    io.sockets.emit("getgoals", goals);
  })();
}
async function updateRedemptions(data) {
  Object.keys(data).forEach((redemption) => {
    if (redemption === "new redemption") {
      database.collection("redemptions").insertOne(data[redemption]);
    } else
      Object.entries(data[redemption]).forEach((field) => {
        database.collection("redemptions").updateOne(
          {
            type: redemption,
          },
          {
            $set: {
              [field[0]]: field[1],
            },
          },
          { upsert: true }
        );
      });
  });
  setTimeout(async () => {
    let redemptions = await initRedemptions();
    io.sockets.emit("getredemptions", redemptions);
  }, 1000);
}
async function deleteRedemption(data) {
  await database.collection("redemptions").deleteOne({ type: data.type });
  (async () => {
    let redemptions = await initRedemptions();
    io.sockets.emit("getredemptions", redemptions);
  })();
}
async function updateVip(data) {
  await database
    .collection("users")
    .findOne({ username: data.username })
    .then(async (res) => {
      if (!res.vip) {
        chatClientAdmin
          .vip("cenoroid", data.username)
          .catch((e) => console.log(e));
      }
      res.vip = res.vip
        ? new Date(
            new Date(res.vip).setFullYear(new Date(res.vip).getFullYear() + 1)
          )
        : new Date(new Date().setFullYear(new Date().getFullYear() + 1));
      await database
        .collection("users")
        .updateOne({ username: res.username }, { $set: { vip: res.vip } });
    });

  data.value = -data.value;
  updateCurrency(data);
}
async function initRequests() {
  requestsArray = await initData("requests");
  for (let index = 0; index < requestsArray.length; index++) {
    requestsArray[index].id = index + 1;
  }
  return requestsArray;
}
async function initGoals() {
  goalsArray = await initData("goals");
  for (let index = 0; index < goalsArray.length; index++) {
    goalsArray[index].id = index + 1;
  }

  return goalsArray;
}
async function initRedemptions() {
  redemptionsArray = await initData("redemptions");
  for (let index = 0; index < redemptionsArray.length; index++) {
    redemptionsArray[index].id = index + 1;
  }

  return redemptionsArray;
}
async function getLog() {
  let last30days = new Date(new Date().setDate(new Date().getDate() - 30));
  data = await database
    .collection("events")
    .find({ date: { $gte: last30days } })
    .sort({ date: -1 })
    .toArray();

  return data;
}

async function initData(collection) {
  res = await database.collection(collection).find({}).toArray();

  return res;
}

function requestTimer(lookup) {
  timer = timer - 1;
  if (timer > 0) return;

  timerRunning = false;
  clearInterval(timerInterval);
  deleteRequest(lookup);
  requestsArray.splice(0, 1);
  for (let index = 0; index < requestsArray.length; index++) {
    requestsArray[index].id = index + 1;
  }
  io.sockets.emit("getrequests", requestsArray);
}
async function linkCheck(data) {
  let link = data.message.split(" ");
  let message = data.message;
  let url = null;
  for (word of link) {
    if (word.includes("youtube")) {
      id = word.split("=")[1];
      message = await getYoutubeTitle(id);
      url = word;
    } else if (word.includes("youtu")) {
      length = word.split("/").length;
      id = word.split("/")[length - 1];
      message = await getYoutubeTitle(id);
      url = word;
    }
  }
  data.message = message;
  data.link = url;
  requestsArray.push({
    name: data.username,
    subtype: data.subtype,
    message: data.message,
    link: data.link,
    id: requestsArray.length + 1,
    lookup: data.lookup,
  });
  io.sockets.emit("getrequests", requestsArray);
  addRequest(data);
  newLog(data);
}
async function getYoutubeTitle(id) {
  url =
    "https://www.googleapis.com/youtube/v3/videos?key=" +
    youtubeAPIKey +
    "&part=snippet&id=" +
    id;
  let { response } = await axios.get(url);
  return response.data.items[0].snippet.title;
}

async function getLogs() {
  let data = await getLog();
  let currentDate = new Date();
  let date = [];
  for (let index = 0; index < data.length; index++) {
    date[index] = new Date(data[index].date);
    let hours = Math.ceil(Math.abs(currentDate - date[index]) / 3600000);
    if (hours < 24) {
      data[index].date = hours + "h";
    } else {
      data[index].date = Math.floor(hours / 24) + "d";
    }
    data[index].id = index;
    if (data[index].event.type === "goal")
      data[index].text =
        data[index].date +
        " - " +
        data[index].user +
        " added to " +
        data[index].event.subtype +
        " - " +
        data[index].event.cost;
    else if (data[index].event.type === "redemption") {
      data[index].text =
        data[index].date +
        " - " +
        data[index].user +
        " redeemed " +
        data[index].event.subtype +
        " - " +
        data[index].event.cost;
    }
  }
  console.log(data.slice(0, 5));
  return data;
}

app.post("/getuser", (req, res) => {
  let data = verifyAndDecode(req.body.userToken);
  (async () => {
    if (data.channel_id === "687993904") {
      return res.json({ username: "isTester", currency: 100 });
    }
    let user = await getUser(data.user_id);
    return res.json(user);
  })();
});

async function deleteEvent(id) {
  database.collection("events").deleteOne({ _id: ObjectId(id) });
}
async function getUser(input) {
  user = await database
    .collection("users")
    .findOne({ userId: input }, { projection: { _id: 0, userId: 0 } });

  if (user === null) {
    let { response } = await axios.get(
      "https://api.twitch.tv/helix/users?id=" + input,
      {
        headers: {
          "client-id": process.env.CLIENT_ID,
          Authorization: process.env.TWITCH_AUTH,
        },
      }
    );

    addUser(response.data.data[0]);
    return {
      username: response.data.data[0].display_name,
      currency: 0,
      userId: response.data.data[0].id,
    };
  }

  if (
    user.vip &&
    new Date(user.vip.toDateString()) < new Date(new Date().toDateString())
  ) {
    chatClientAdmin.unvip("cenoroid", user.username);

    database
      .collection("users")
      .updateOne({ username: user.username }, { $unset: { vip: "" } });
  }

  return user;
}
async function getSettings() {
  let settings = await database.collection("settings").find({}).toArray();

  let entries = new Map();
  for (let i = 0; i < settings.length; i++) {
    entries.set(settings[i].type, settings[i]);
  }
  return Object.fromEntries(entries);
}
async function getGreenBarData() {
  let greenbar = await database.collection("greenbar").findOne({});

  io.sockets.emit("greenbardata", greenbar);
}
async function resetGreenBar(data) {
  let greenbar = await database
    .collection("greenbar")
    .findOne({ _id: ObjectId("6080e9c360ce6ffaba4d2399") });

  if (greenbar.ran) {
    update = { ran: false };
  } else if (greenbar.current >= greenbar.end) {
    update = {
      current: greenbar.current - greenbar.end,
      end: greenbar.end + 5,
      ran: data ? true : false,
    };
  } else {
    update = { end: greenbar.end - 5 };
  }
  await database.collection("greenbar").updateOne(
    { _id: ObjectId("6080e9c360ce6ffaba4d2399") },
    {
      $set: update,
    }
  );
  getGreenBarData();
  if (data) {
    io.sockets.emit("pinata", greenbar.end);
  }
}
greenBarTitleArray = [];
greenBarCd = false;

async function updateGreenBarTitle() {
  if (greenBarTitleArray.length > 0) {
    if (greenBarCd) return;

    greenBarCd = true;
    await database.collection("greenbar").updateOne(
      { _id: ObjectId("6080e9c360ce6ffaba4d2399") },
      {
        $set: {
          title: greenBarTitleArray[0],
        },
      }
    );

    io.sockets.emit("greenbartitle", greenBarTitleArray[0]);
    setTimeout(() => {
      greenBarCd = false;
      greenBarTitleArray.shift();
      updateGreenBarTitle();
    }, 30000);
  }
}

async function updateGreenBarAmount(value) {
  await database
    .collection("greenbar")
    .updateOne({ _id: ObjectId("6080e9c360ce6ffaba4d2399") }, [
      {
        $set: { current: { $round: [{ $add: ["$current", value] }, 2] } },
      },
    ]);

  io.sockets.emit("greenbarcurrent", value);
}

async function resetGoal(goal) {
  await database
    .collection("goals")
    .updateOne({ goal }, { $set: { current: 0 } });

  let goalsArray = await initGoals();
  io.sockets.emit("getgoals", goalsArray);
}

async function addUser(input) {
  await database.collection("users").updateOne(
    { username: input.display_name },
    {
      $set: {
        userId: input.id,
        currency: 0,
      },
    },
    { upsert: true }
  );
}

async function newLog(input) {
  await database.collection("events").insertOne({
    user: input.username,
    event: {
      type: input.type,
      subtype: input.subtype,
      message: input.message,
      cost: input.value,
    },
    date: new Date(),
  });

  database.collection("charity").updateOne(
    {
      lookup: "fund",
    },
    { $inc: { current: -input.value / 10 } }
  );

  let logs = await getLogs();
  io.sockets.emit("geteventlog", logs);
}
async function addRequest(input) {
  await database.collection("requests").insertOne({
    name: input.username,
    type: input.type,
    subtype: input.subtype,
    message: input.message,
    link: input.link,
    lookup: input.lookup,
  });

  input.value = -input.value;
  updateCurrency(input);
}
async function updateGoal(search) {
  await database
    .collection("goals")
    .updateOne({ goal: search.goal }, { $inc: { current: search.value } });
}
async function updateCurrency(data) {
  data.value = Number(data.value);
  await database
    .collection("users")
    .updateOne({ username: data.username }, { $inc: { currency: data.value } });

  io.to(data.username.toLowerCase()).emit("updatecurrency", data.value);
}

function deleteRequest(search) {
  database.collection("requests").deleteOne({ lookup: search });
}

server.listen(process.env.PORT || 5000, () => {
  console.log("second server works");
});
app.get("/", () => {
  console.log("Second server ping.");
});
