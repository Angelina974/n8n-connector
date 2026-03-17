# n8n-nodes-monservice (AirProcess)

Connecteur n8n communautaire pour AirProcess.

## Développement local

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Node inclus

- `AirProcess`
  - `Get` un record: `GET /{MODEL_ID}/{RECORD_ID}`
  - `Get Many` records: `GET /{MODEL_ID}`
  - `Create` un record: `POST /{MODEL_ID}`

## Authentification

Le node utilise le credential n8n natif `Bearer Auth` (`httpBearerAuth`).

## Base URL

`https://app.airprocess.com`
