const Swagger = require('swagger-client');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Helper to fetch credentials from AWS Secrets Manager
const credentialsArn = process.env.JWT_CREDENTIALS_SECRET_ARN;
let cachedCredentials = null;
async function getCredentials() {
  if (cachedCredentials) return cachedCredentials;
  const client = new SecretsManagerClient({ region: 'eu-central-1' });
  const command = new GetSecretValueCommand({ SecretId: credentialsArn });
  const response = await client.send(command);
  cachedCredentials = JSON.parse(response.SecretString);
  return cachedCredentials;
}

const toolExecutors = {
  tracker_dynamic: async (toolName, args, bearerToken) => {
    const apiUrl = process.env.MTG_BACKEND_API_URL;
    const swaggerUrl = `${apiUrl}/api-docs/swagger.json`;
    const operationId = toolName.replace(/^tracker_/, "");

    try {
      if (!bearerToken) {
        bearerToken = await getBearerToken();
      }
      const client = await Swagger({
        url: swaggerUrl,
        requestInterceptor: req => {
          req.headers = req.headers || {};
          req.headers["Authorization"] = `Bearer ${bearerToken}`;
          return req;
        }
      });

      // Fetch operation spec to split parameters
      const op = client.spec.paths;
      let opSpec;
      for (const path in op) {
        for (const method in op[path]) {
          if (op[path][method].operationId === operationId) {
            opSpec = op[path][method];
            break;
          }
        }
      }

      // Split args into parameters and requestBody
      const paramArgs = {};
      let requestBody = undefined;
      if (opSpec && opSpec.parameters) {
        opSpec.parameters.forEach(param => {
          if (param.in === "path" || param.in === "query") {
            if (args[param.name] !== undefined) paramArgs[param.name] = args[param.name];
          }
        });
      }
      // Handle requestBody (OpenAPI 3.x)
      if (opSpec && opSpec.requestBody && args.body) {
        requestBody = args.body;
      } else if (opSpec && opSpec.requestBody) {
        // If body fields are top-level in args, collect them
        requestBody = {};
        const bodyProps = opSpec.requestBody.content?.["application/json"]?.schema?.properties || {};
        Object.keys(bodyProps).forEach(key => {
          if (args[key] !== undefined) requestBody[key] = args[key];
        });
        if (Object.keys(requestBody).length === 0) requestBody = undefined;
      }

      // Execute the operation directly
      const res = await client.execute({
        operationId,
        parameters: paramArgs,
        ...(requestBody && { requestBody })
      });
      // Return the response data
      return res.body || { status: "success" };
    } catch (err) {
      return { error: err.message };
    }
  }
};

async function scryfallSearch({ name, oracle_text, colors, set, page, order, dir }) {
  let query = [];

  if (name) query.push(`name:"${name}"`);
  if (oracle_text) query.push(`o:"${oracle_text}"`);
  if (colors && colors.length > 0) query.push(`c:"${colors.join('')}"`);
  if (set) query.push(`set:${set}`);
  query.push("game:paper");
  query.push("unique:prints");

  const params = new URLSearchParams({
    q: query.join(" "),
    ...(page && { page }),
    ...(order && { order }),
    ...(dir && { dir }),
  });

  const res = await fetch(`https://api.scryfall.com/cards/search?${params.toString()}`);
  return res.json();
}

function storeSingleCard({ set_code, collector_number, image_url }) {
    console.log("Storing single card:", { set_code, collector_number, image_url });
    return { status: "success", set_code, collector_number, image_url };
}

async function getBearerToken() {
  const apiUrl = process.env.MTG_BACKEND_API_URL;
  const secret = await getCredentials();
  const basicAuth = btoa(`${secret.username}:${secret.password}`);
  const res = await fetch(`${apiUrl}/gettoken`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${basicAuth}`
    }
  });
  const data = await res.json();  
  return data.token;
}

module.exports = {
    toolExecutors,
    scryfallSearch,
    storeSingleCard
};