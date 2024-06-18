require("dotenv").config();
const express = require("express");
const request = require("request-promise-native");
const NodeCache = require("node-cache");
const session = require("express-session");
const path = require("path");

// const opn = require("open");
const app = express();
// app.use('/images', express.static('public/images'));

app.use(express.static(path.join(__dirname, "..", "public")));

// const PORT = 3000;

const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
  throw new Error("Missing CLIENT_ID or CLIENT_SECRET environment variable.");
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config,
// or set them as environment variables before running.
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Scopes for this app will default to `crm.objects.contacts.read`
// To request others, set the SCOPE environment variable instead
let SCOPES = ["crm.objects.contacts.read"];
if (process.env.SCOPE) {
  SCOPES = process.env.SCOPE.split(/ |, ?|%20/).join(" ");
}

console.log("SCOPES", SCOPES);

// On successful install, users will be redirected to /oauth-callback
// const REDIRECT_URI = `https://zenquotes-with-hubspot.vercel.app/oauth-callback`;

const PORT = process.env.PORT || 4000;
const REDIRECT_URI = `https://${
  process.env.DOMAIN || `localhost:${PORT}`
}/oauth-callback`;

console.log("REDIRECT_URI", REDIRECT_URI);
// const REDIRECT_URI = `https://${process.env.VERCEL_URL}/oauth-callback`;
//===========================================================================//

// Use a session to keep track of client ID
app.use(
  session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true,
  })
);

//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app

const authUrl =
  "https://app.hubspot.com/oauth/authorize" +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
  `&scope=${encodeURIComponent(SCOPES)}` + // scopes being requested by the app
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

// Redirect the user from the installation page to
// the authorization URL
app.get("/install", (req, res) => {
  console.log("");
  console.log("=== Initiating OAuth 2.0 flow with HubSpot ===");
  console.log("");
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  res.redirect(authUrl);
  console.log("===> Step 2: User is being prompted for consent by HubSpot");
});

app.get("/oauth-callback", async (req, res) => {
  console.log("===> Step 3: Handling the request sent by the server");

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log("       > Received an authorization token");

    const authCodeProof = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code,
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log(
      "===> Step 4: Exchanging authorization code for an access token and refresh token"
    );
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    res.redirect(`/`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post(
      "https://api.hubapi.com/oauth/v1/token",
      {
        form: exchangeProof,
      }
    );
    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(
      userId,
      tokens.access_token,
      Math.round(tokens.expires_in * 0.75)
    );

    console.log("       > Received an access token and refresh token");
    return tokens.access_token;
  } catch (e) {
    console.error(
      `       > Error exchanging ${exchangeProof.grant_type} for access token`
    );
    return JSON.parse(e.response.body);
  }
};

const refreshAccessToken = async (userId) => {
  const refreshTokenProof = {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId],
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log("Refreshing expired access token");
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

const getContact = async (accessToken) => {
  console.log("");
  console.log(
    "=== Retrieving a contact from HubSpot using the access token ==="
  );
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    console.log(
      "===> Replace the following request.get() to test other API calls"
    );
    console.log(
      "===> request.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1')"
    );
    const result = await request.get(
      "https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1",
      {
        headers: headers,
      }
    );

    return JSON.parse(result).contacts[0];
  } catch (e) {
    console.error("  > Unable to retrieve contact");
    return JSON.parse(e.response.body);
  }
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === "error") {
    res.write(
      `<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`
    );
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(
    `<p>Here's a sample contact in this account. Contact name: ${firstname.value} ${lastname.value}</p>`
  );
};

app.get("/", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.write(`<style>
    body { 
      font-family: 'Lexend Deca', sans-serif; 
      margin: 10px 10px; 
      padding: 10px 10px; 
      background-color: #f0f0f0; 
      display: flex; 
      justify-content: center; 
      align-items: center; 
      height: 100vh; 
    }
    .content { text-align: center; }
    h2 { color: #333; }
    p { color: #666; }
    img { max-width: 20%; border: 1px solid #000000 }
    .install-btn { 
      background-color: #4CAF50; 
      border: none; 
      color: white; 
      padding: 15px 32px; 
      text-align: center; 
      text-decoration: none; 
      display: inline-block; 
      font-size: 16px; 
      margin: 4px 2px; 
      cursor: pointer; 
    }
  </style>`);
  res.write(`<div class="content">`);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    // res.write(`<h4>Access token: ${accessToken}</h4>`);
    res.write(
      `<h2>Congratulations! You just installed a new app!</h2>`
    );

    displayContactName(res, contact);
    res.write(
      `<p>After you install this app, open contact record page, click <b>Customize this tab</b> in the middle column, and find your card in <b>Extensions</b> category. Have fun!</p>`
    );
    res.write(`<img src="/images/config.gif" alt="config">`);
  } else {
    res.write(`<h2>App cards treasure hunt!</h2>`);
    res.write(`<img src="/images/treasurehunt.png" alt="treasure hunt image">`);
    res.write(`<p>App cards are available on record page middle columns, right sidebars, and preview sidebars. This app contains several cards for many of these locations across all standard objects.</p>`);
    res.write(`<p>Your mission, should you choose to accept it, is to discover how many app cards are installed by this app, configure them successfully, and see what they display when you open them on different locations!</p>`);
    res.write(
      `<br><br><a href="/install" class="install-btn">Install the app</a>`
    );
    res.write(
      `<p>Note: this is a test app created by Sejal Parikh, it is not actively being maintained.</p>`
    );
  }
  res.write(`</div>`);
  res.end();
});

app.get("/error", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

module.exports = app;

app.listen(PORT, () => console.log(`=== Starting your app on localhost ===`));
