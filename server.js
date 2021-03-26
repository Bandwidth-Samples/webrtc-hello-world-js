const fs = require("fs");
const express = require("express");
const BandwidthWebRTC = require("@bandwidth/webrtc");
const BandwidthVoice = require("@bandwidth/voice");
const uuid = require("uuid");
const dotenv = require("dotenv").config();
const jwt_decode = require("jwt-decode");
const app = express();
const bodyParser = require("body-parser");
app.use(bodyParser.json());
app.use(express.static("public"));

// config
const port = 3000;
const localDir = __dirname;
const accountId = process.env.ACCOUNT_ID;

// Global variables
BandwidthWebRTC.Configuration.basicAuthUserName = process.env.USERNAME;
BandwidthWebRTC.Configuration.basicAuthPassword = process.env.PASSWORD;
var webRTCController = BandwidthWebRTC.APIController;

BandwidthVoice.Configuration.basicAuthUserName = process.env.USERNAME;
BandwidthVoice.Configuration.basicAuthPassword = process.env.PASSWORD;
var voiceController = BandwidthVoice.APIController;

// create a map of PSTN calls that will persist
let calls = new Map();

// track our session ID and phone call Id
//  - if not a demo, these would be stored in persistant storage
let sessionId = false;
let callId = false;

/**
 * Setup the call and pass info to the browser so they can join
 */
app.get("/startBrowserCall", async (req, res) => {
  console.log("setup browser client");
  try {
    // create the session
    let session_id = await getSessionId(accountId, "session-test");

    let [participant, token] = await createParticipant(accountId, uuid.v1());

    await addParticipantToSession(accountId, participant.id, session_id);
    // now that we have added them to the session, we can send back the token they need to join
    res.send({
      message: "created particpant and setup session",
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
    session_id = await getSessionId();

    let [participant, token] = await createParticipant(accountId, uuid.v1());

    await addParticipantToSession(accountId, participant.id, session_id);

    console.log("start the PSTN call to", process.env.OUTBOUND_PHONE_NUMBER);
    callResponse = await initiateCallToPSTN(
      accountId,
      process.env.FROM_NUMBER,
      process.env.OUTBOUND_PHONE_NUMBER
    );

    // store the token with the participant for later use
    participant.token = token;
    callId = callResponse.callId;

    calls.set(callResponse.callId, participant);
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
  console.log(`transferring call ${callId} to session ${sessionId}`);
  const bxml = webRTCController.generateTransferBxml(participant.token);

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
    session_id = await getSessionId();

    await endCallToPSTN(accountId, callId);
    res.send({ status: "hungup" });
  } catch (error) {
    console.log(
      `error hanging up ${process.env.OUTBOUND_PHONE_NUMBER}:`,
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
 * @param session_id
 */
function saveSessionId(session_id) {
  // saved globally for simplicity of demo
  sessionId = session_id;
}
/**
 * Return the session id
 * This will either create one via the API, or return the one already created for this session
 * @param account_id
 * @param tag
 * @return a Session id
 */
async function getSessionId(account_id, tag) {
  // check if we've already created a session for this call
  //  - this is a simplification we're doing for this demo
  if (sessionId) {
    return sessionId;
  }

  console.log("No session found, creating one");
  // otherwise, create the session
  // tags are useful to audit or manage billing records
  var sessionBody = new BandwidthWebRTC.Session({ tag: tag });

  try {
    let sessionResponse = await webRTCController.createSession(
      account_id,
      sessionBody
    );
    // saves it for future use, this would normally be stored with meeting/call/appt details
    saveSessionId(sessionResponse.id);

    return sessionResponse.id;
  } catch (error) {
    console.log("Failed to create session:", error);
    throw new Error(
      "Error in createSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 *  Create a new participant
 * @param account_id
 * @param tag to tag the participant with, no PII should be placed here
 * @return list: (a Participant json object, the participant token)
 */
async function createParticipant(account_id, tag) {
  // create a participant for this browser user
  var participantBody = new BandwidthWebRTC.Participant({
    tag: tag,
    publishPermissions: ["AUDIO"],
  });

  try {
    let createResponse = await webRTCController.createParticipant(
      accountId,
      participantBody
    );

    return [createResponse.participant, createResponse.token];
  } catch (error) {
    console.log("failed to create Participant", error);
    throw new Error(
      "Failed to createParticipant, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * @param account_id The id for this account
 * @param participant_id a Participant id
 * @param session_id The session to add this participant to
 */
async function addParticipantToSession(account_id, participant_id, session_id) {
  var body = new BandwidthWebRTC.Subscriptions({ sessionId: session_id });

  try {
    await webRTCController.addParticipantToSession(
      accountId,
      session_id,
      participant_id,
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
async function initiateCallToPSTN(account_id, from_number, to_number) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCalls.html
  var body = new BandwidthVoice.ApiCreateCallRequest({
    from: from_number,
    to: to_number,
    applicationId: process.env.VOICE_APPLICATION_ID,
    answerUrl: process.env.BASE_CALLBACK_URL + "callAnswered",
    answerMethod: "POST",
    callTimeout: "30",
  });

  return await voiceController.createCall(accountId, body);
}

/**
 * End the PSTN call
 * @param account_id The id for this account
 * @param call_id The id of the call
 */
async function endCallToPSTN(account_id, call_id) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCallsCallId.html
  var body = new BandwidthVoice.ApiModifyCallRequest({ state: "completed" });
  try {
    await voiceController.modifyCall(accountId, call_id, body);
  } catch (error) {
    console.log("Failed to hangup the call", error);
    throw error;
  }
}
