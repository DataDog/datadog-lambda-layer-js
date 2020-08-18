const { datadog, sendDistributionMetric } = require("datadog-lambda-js");
const https = require("https");

const paths = ["/400", "/500"];
const urls = ["httpstat.us", "httpstat.us"];

async function handle(event, context) {
  const responsePayload = { message: "hello, dog!" };

  sendDistributionMetric("serverless.integration_test.execution", 1, "function:http-request");

  for (let index = 0; index < urls.length; index++) {
    await httpsGet(urls[index], paths[index]);
  }

  console.log(`Snapshot test http requests successfully made to URLs: ${urls}`);

  return responsePayload;
}

async function httpsGet(url, path) {
  const requestOptions = {
    host: url,
    method: "GET",
    protocol: "https:",
    path,
  };

  return new Promise(function(resolve, reject) {
    const request = https.request(requestOptions);

    request.on("response", (response) => {
      return resolve(response);
    });
    request.on("error", (error) => {
      return reject(error);
    });

    request.end();
  });
}

module.exports.handle = process.env.WITH_PLUGIN ? handle : datadog(handle);
