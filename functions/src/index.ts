import { setGlobalOptions } from 'firebase-functions/v2'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { handleGmailScan } from './scan.js'
import { handleNightlyArchive } from './archive.js'

const anthropicKey    = defineSecret('ANTHROPIC_API_KEY')
const googleAiKey     = defineSecret('GOOGLE_AI_API_KEY')
const googleClientId  = defineSecret('GOOGLE_CLIENT_ID')
const googleClientSec = defineSecret('GOOGLE_CLIENT_SECRET')

setGlobalOptions({
  region:       'europe-west1',
  maxInstances: 10,
})

export const gmailScan = onRequest(
  {
    secrets:        [anthropicKey, googleAiKey, googleClientId, googleClientSec],
    timeoutSeconds: 3600,
    memory:         '512MiB',
    cors:           false,
  },
  handleGmailScan
)

export const nightlyArchive = onSchedule(
  {
    schedule:       '0 2 * * *',
    timeZone:       'Europe/London',
    memory:         '256MiB',
    timeoutSeconds: 540,
  },
  async () => {
    await handleNightlyArchive()
  }
)
