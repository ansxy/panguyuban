---
name: endpoint-requests
description: Keep a ready-to-send request for every HTTP endpoint in the project's Postman collection, so people can hit it by hand later in Postman or in Panguyuban's Requests view. Use whenever you add, change or remove an HTTP endpoint, and whenever you curl one of the project's endpoints to check it.
---

# Endpoint Requests

Every endpoint you add, change or remove gets the same change in `docs/api/<project>.postman_collection.json` (Postman v2.1), in the same piece of work. If you checked an endpoint with `curl`, that request goes in too. Use an existing `*.postman_collection.json` instead if the project has one.

```json
{
  "info": { "name": "<project> API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:3000" },
    { "key": "token", "value": "" },
    { "key": "claimId", "value": "1" }
  ],
  "item": [
    {
      "name": "Orders",
      "item": [
        {
          "name": "Update order",
          "request": {
            "method": "PATCH",
            "description": "Changes a order amount. 404 when the order is not yours, 422 when it is already approved.",
            "url": { "raw": "{{baseUrl}}/api/orders/{{claimId}}" },
            "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
            "body": { "mode": "raw", "raw": "{\n  \"amount\": 1500000\n}", "options": { "raw": { "language": "json" } } }
          }
        }
      ]
    }
  ]
}
```

- One folder per feature; one request per endpoint (match on method + path, never duplicate).
- `baseUrl` = local dev address; path params are variables with a sample value.
- Body passes the endpoint's validation; description says what it does and its main errors.
- **Never real data:** no tokens, passwords, keys, real names, ID, account or record numbers, or non-local hosts. Leave secret variables empty; use made-up values.

Then: check the file is valid JSON, send the changed requests if the server runs (say so if it can't), and name the file and requests you touched in your summary.
