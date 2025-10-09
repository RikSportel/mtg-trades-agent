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
    scryfall_search: async (args) => {
        //console.log("Executing scryfall_search with args:", args);
        return await scryfallSearch(args);
    },

    local_singlecard: (args) => {
        //console.log("Executing local_singlecard with args:", args);
        return storeSingleCard(args);
    },
    
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

      console.log(`Sending request: operationId=${operationId}, parameters=${JSON.stringify(paramArgs)}, requestBody=${JSON.stringify(requestBody)}`);
      // Execute the operation directly
      const res = await client.execute({
        operationId,
        parameters: paramArgs,
        ...(requestBody && { requestBody })
      });

      return { status: "success" };
    } catch (err) {
      return { error: err.message };
    }
  }
};

async function scryfallSearch({ name, oracle_text, type, reserved, colors, set, page, order, dir }) {
  let query = [];
  if (name) query.push(`name:"${name}"`);
  if (oracle_text) {
    oracle_text.split(/\s+/).forEach(word => {
      if (word) query.push(`o:"${word}"`);
    });
  }
  if (type) {
    type.split(/\s+/).forEach(word => {
      if (word) query.push(`t:"${word}"`);
    });
  }
  if (reserved) query.push("is:reserved");
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
 
  const json = await res.json();
  return {"summary": 
  (json.data || []).map(card => ({
    set: card.set,
    collector_number: card.collector_number
  })),"details": json.data || []}
}

function storeSingleCard({ set_code, collector_number, image_url }) {
    console.log("Storing single card:", { set_code, collector_number, image_url });
    return { status: "success", set_code, collector_number, image_url };
}

async function getBearerToken() {
    const apiUrl = process.env.MTG_BACKEND_API_URL;
    let secret;
    if (process.env.JWT_CREDENTIALS) {
        const [username, password] = process.env.JWT_CREDENTIALS.split(':');
        secret = { username, password };
    } else {
        secret = await getCredentials();
    }
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
    toolExecutors
};