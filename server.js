import express from "express";
import bodyParser from "body-parser";
import BandwidthWebRTC from "@bandwidth/webrtc";
import BandwidthVoice from "@bandwidth/voice";
import { v1 as uuidv1 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(bodyParser.json());
app.use(express.static("public"));

// config
const port = 3000;
const accountId = process.env.BW_ACCOUNT_ID;
const username = process.env.BW_USERNAME;
const password = process.env.BW_PASSWORD;

// Check to make sure required environment variables are set
if (!accountId || !username || !password) {
  console.error(
      "ERROR! Please set the BW_ACCOUNT_ID, BW_USERNAME, and BW_PASSWORD environment variables before running this app"
  );
  process.exit(1);
}

// Global variables
const {Client: WebRTCClient, ApiController: WebRTCController} = BandwidthWebRTC;
const webrtcClient = new WebRTCClient({
  basicAuthUserName: username,
  basicAuthPassword: password
});
const webRTCController = new WebRTCController(webrtcClient);

const {Client: VoiceClient, ApiController: VoiceController} = BandwidthVoice;
const voiceClient = new VoiceClient({
  basicAuthUserName: username,
  basicAuthPassword: password
});
const voiceController = new VoiceController(voiceClient);

// create a map of PSTN calls that will persist
const calls = new Map();

// track our session ID and phone call Id
//  - if not a demo, these would be stored in persistent storage
let currentSessionId = false;
let currentCallId = false;

/**
 * Setup the call and pass info to the browser so they can join
 */
app.get("/startBrowserCall", async (req, res) => {
  console.log("setup browser client");
  try {
    // create the session
    let sessionId = await getSessionId("session-test");

    let [participant, token] = await createParticipant(uuidv1());

    await addParticipantToSession(participant.id, sessionId);
    // now that we have added them to the session, we can send back the token they need to join
    res.send({
      message: "created participant and setup session",
      token: token,
    });
  } catch (error) {
    console.log("Failed to start the browser call:", error);
    res.status(500).send({ message: "failed to set up participant" });
  }
});

/**
 * Start the Phone Call
 */
app.get("/startPSTNCall", async (req, res) => {
  try {
    let sessionId = await getSessionId();

    let [participant, token] = await createParticipant(uuidv1());

    await addParticipantToSession(participant.id, sessionId);

    console.log("start the PSTN call to", process.env.USER_NUMBER);
    let callResponse = await initiateCallToPSTN(
      process.env.BW_NUMBER,
      process.env.USER_NUMBER
    );

    // store the token with the participant for later use
    participant.token = token;
    currentCallId = callResponse.result.callId;

    calls.set(currentCallId, participant);
    res.send({ status: "ringing" });
  } catch (error) {
    console.log("Failed to start PSTN call:", error);
    res.status(500).send({ message: "failed to set up PSTN call" });
  }
});

/**
 * Bandwidth's Voice API will hit this endpoint when an outgoing call is answered
 */
app.post("/callAnswered", async (req, res) => {
  let callId = req.body.callId;
  console.log(
    `received answered callback for call ${callId} to ${req.body.to}`
  );

  const participant = calls.get(callId);
  if (!participant) {
    console.log(`no participant found for ${callId}!`);
    res.status(200).send(); // have to return 200 to the BAND server
    return;
  }

  // This is the response payload that we will send back to the Voice API to transfer the call into the WebRTC session
  // Use the SDK to generate this BXML
  console.log(`transferring call ${callId} to session ${currentSessionId}`);
  const bxml = WebRTCController.generateTransferBxml(participant.token, callId);

  // Send the payload back to the Voice API
  res.contentType("application/xml").send(bxml);
  console.log("transferred");
});

/**
 * End the Phone Call
 */
app.get("/endPSTNCall", async (req, res) => {
  console.log("Hanging up PSTN call");
  try {
    await getSessionId();

    await endCallToPSTN(currentCallId);
    res.send({ status: "hungup" });
  } catch (error) {
    console.log(
      `error hanging up ${process.env.USER_NUMBER}:`,
      error
    );
    res.status(500).send({ status: "call hangup failed" });
  }
});

/**
 * start our server
 */
app.listen(port, () => {
  console.log(`Example app listening on port  http://localhost:${port}`);
});

// ------------------------------------------------------------------------------------------
// All the functions for interacting with Bandwidth WebRTC services below here
//
/**
 * @param sessionId New current session ID
 */
function saveSessionId(sessionId) {
  // saved globally for simplicity of demo
  currentSessionId = sessionId;
  console.log('Saved session %s', sessionId);
}
/**
 * Return the session id
 * This will either create one via the API, or return the one already created for this session
 * @param tag
 * @return a Session id
 */
async function getSessionId(tag) {
  // check if we've already created a session for this call
  //  - this is a simplification we're doing for this demo
  if (currentSessionId) {
    return currentSessionId;
  }

  console.log("No session found, creating one");
  // otherwise, create the session
  // tags are useful to audit or manage billing records
  const sessionBody = { tag: tag };

  try {
    let sessionResponse = await webRTCController.createSession(
      accountId,
      sessionBody
    );
    // saves it for future use, this would normally be stored with meeting/call/appt details
    saveSessionId(sessionResponse.result.id);

    return sessionResponse.result.id;
  } catch (error) {
    console.log("Failed to create session:", error);
    throw new Error(
      "Error in createSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 *  Create a new participant
 * @param tag to tag the participant with, no PII should be placed here
 * @return list: (a Participant json object, the participant token)
 */
async function createParticipant(tag) {
  // create a participant for this browser user
  const participantBody = {
    tag: tag,
    publishPermissions: ["AUDIO"],
    deviceApiVersion: "V3"
  };

  try {
    let createResponse = await webRTCController.createParticipant(
      accountId,
      participantBody
    );

    return [createResponse.result.participant, createResponse.result.token];
  } catch (error) {
    console.log("failed to create Participant", error);
    throw new Error(
      "Failed to createParticipant, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * @param participantId a Participant id
 * @param sessionId The session to add this participant to
 */
async function addParticipantToSession(participantId, sessionId) {
  const body = { sessionId: sessionId };

  try {
    await webRTCController.addParticipantToSession(
      accountId,
      sessionId,
      participantId,
      body
    );
  } catch (error) {
    console.log("Error on addParticipant to Session:", error);
    throw new Error(
      "Failed to addParticipantToSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * Start a call out to the PSTN
 * @param account_id The id for this account
 * @param from_number the FROM on the call
 * @param to_number the number to call
 */
async function initiateCallToPSTN(fromNumber, toNumber) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCalls.html
  const body = {
    from: fromNumber,
    to: toNumber,
    applicationId: process.env.BW_VOICE_APPLICATION_ID,
    answerUrl: process.env.BASE_CALLBACK_URL + "/callAnswered",
    answerMethod: "POST",
    callTimeout: "30",
  };

  return await voiceController.createCall(accountId, body);
}

/**
 * End the PSTN call
 * @param callId The id of the call
 */
async function endCallToPSTN(callId) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCallsCallId.html
  const body = {
    state: "completed",
    redirectUrl: "foo"
  };
  try {
    await voiceController.modifyCall(accountId, callId, body);
  } catch (error) {
    console.log("Failed to hangup the call", error);
    throw error;
  }
}
