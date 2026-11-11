// Google Drive sync settings. Leave GOOGLE_CLIENT_ID empty to run in local-only mode
// (each device keeps its own data, anyone can edit). See README.md for how to obtain the values.
//
// None of these values is a secret: the client ID and API key are meant to be public, but you MUST
//   - restrict the API key to your site's address (HTTP referrers) and to the Drive + Picker APIs, and
//   - list only your site's address under "Authorized JavaScript origins" for the OAuth client.
window.SGRBC_CONFIG = {
  GOOGLE_CLIENT_ID: "172975792507-ll0u9f6ps1nqe3la3i2craskdtoa0l1b.apps.googleusercontent.com",   // e.g. "1234567890-abc123.apps.googleusercontent.com"
  GOOGLE_API_KEY: "AIzaSyAkS71_4hIGzjq9Fm8vxTNK6MxtjiuLur4",     // browser API key (Drive API + Picker API), referrer-restricted
  GOOGLE_APP_ID: "172975792507",      // numeric Google Cloud project number (the digits before the "-" in the client ID)
  DRIVE_FILE_ID: "1o8HTQwrGBlybHnZPryqm1i0yBu2F9ltT"       // optional: ID of the shared data file once created, so every device uses it automatically
};
