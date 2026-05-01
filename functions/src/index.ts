import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { handleGmailScan } from './scan.js'

// Secrets — must be created via: firebase functions:secrets:set ANTHROPIC_API_KEY
const anthropicKey = defineSecret('ANTHROPIC_API_KEY')
const googleAiKey  = defineSecret('GOOGLE_AI_API_KEY')

setGlobalOptions({
  region:         'europe-west1',  // closest to Firestore eur3
  maxInstances:   10,
})

export const gmailScan = onRequest(
  {
    secrets:        [anthropicKey, googleAiKey],
    timeoutSeconds: 3600,   // 60 minutes — handles even large onboarding scans
    memory:         '512MiB',
    cors:           false,  // we handle CORS manually in handleGmailScan
  },
  handleGmailScan
)
