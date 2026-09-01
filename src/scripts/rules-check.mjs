/**
 * rules-check.mjs — behavioural tests for firestore.rules
 *
 *   npm run test:rules
 *
 * Run this after ANY change to firestore.rules, and before deploying them.
 *
 * Guards the footgun introduced in docs/relevance-brain-design.md §6.1: the
 * blanket users/{userId}/{document=**} grant was replaced with enumerated
 * per-collection rules, because Firestore ORs all matching rules together — a
 * blanket allow-write silently defeats the append-only and server-only rules.
 *
 * Consequences this file exists to catch:
 *   - a NEW client-written collection added without a matching rule (denied in
 *     production, works fine in dev against a permissive local ruleset)
 *   - the append-only guarantee on the evidence log quietly regressing
 *   - the learned model (brain/priors/entities) becoming client-writable
 *
 * Requires Java for the Firestore emulator.
 */
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc, collection, Timestamp } from 'firebase/firestore'

const env = await initializeTestEnvironment({
  projectId: 'keel-rules-check',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
})

const alice = env.authenticatedContext('alice').firestore()
const mallory = env.authenticatedContext('mallory').firestore()
const anon = env.unauthenticatedContext().firestore()

const validEvent = () => ({
  action: 'marked_done', source: 'expanded_panel', itemId: 'item_1',
  createdAt: Timestamp.now(),
  prior: { score: 0.8, status: 'awaiting_action', categoryId: 'cat_work', manualPriority: false, autoQuietedReason: null },
  facts: { senderEmail: 'a@b.com', senderDomain: 'b.com', aiTitle: 't', threadId: 'th', isOutbound: false, isRecurring: false, ageHours: 3, signalTypes: ['payment'], nearestSignalDays: 2 },
})

let pass = 0, fail = 0
const check = async (name, expect, fn) => {
  try { await (expect === 'allow' ? assertSucceeds(fn()) : assertFails(fn())); console.log(`  PASS  ${name}`); pass++ }
  catch (e) { console.log(`  FAIL  ${name} — ${String(e).slice(0, 110)}`); fail++ }
}

console.log('\nRegression — existing app collections still work for their owner:')
for (const c of ['accounts','categories','categoryHints','ignoredSenders','items','meta','outbound','payments','preferences','scanRuns','signals']) {
  await check(`write users/alice/${c}`, 'allow', () => setDoc(doc(alice, `users/alice/${c}/d1`), { x: 1 }))
  await check(`read  users/alice/${c}`, 'allow', () => getDoc(doc(alice, `users/alice/${c}/d1`)))
}
await check('write users/alice (root doc)', 'allow', () => setDoc(doc(alice, 'users/alice'), { email: 'a@b.com' }))

console.log('\nEvidence log — append-only:')
await check('create valid feedback event', 'allow', () => addDoc(collection(alice, 'users/alice/feedback'), validEvent()))
await check('read own feedback', 'allow', () => getDoc(doc(alice, 'users/alice/feedback/e1')))
await setDoc(doc(alice, 'users/alice/feedback/e1'), validEvent())   // seed via allowed create
await check('UPDATE own feedback event', 'deny', () => updateDoc(doc(alice, 'users/alice/feedback/e1'), { action: 'ignored_item' }))
await check('DELETE own feedback event', 'deny', () => deleteDoc(doc(alice, 'users/alice/feedback/e1')))
await check('create event missing required fields', 'deny', () => addDoc(collection(alice, 'users/alice/feedback'), { action: 'x' }))
await check('create event with non-string action', 'deny', () => addDoc(collection(alice, 'users/alice/feedback'), { ...validEvent(), action: 42 }))
await check('create event with non-timestamp createdAt', 'deny', () => addDoc(collection(alice, 'users/alice/feedback'), { ...validEvent(), createdAt: 'now' }))

console.log('\nLearned model — client read, never client write:')
for (const c of ['brain','priors','entities']) {
  await check(`read  users/alice/${c}`, 'allow', () => getDoc(doc(alice, `users/alice/${c}/d1`)))
  await check(`WRITE users/alice/${c}`, 'deny', () => setDoc(doc(alice, `users/alice/${c}/d1`), { x: 1 }))
}
await check('read  users/alice/evals', 'deny', () => getDoc(doc(alice, 'users/alice/evals/g1')))
await check('WRITE users/alice/evals', 'deny', () => setDoc(doc(alice, 'users/alice/evals/g1'), { x: 1 }))

console.log('\nIsolation:')
await check('mallory reads alice items', 'deny', () => getDoc(doc(mallory, 'users/alice/items/d1')))
await check('mallory writes alice feedback', 'deny', () => addDoc(collection(mallory, 'users/alice/feedback'), validEvent()))
await check('mallory reads alice brain', 'deny', () => getDoc(doc(mallory, 'users/alice/brain/profile')))
await check('anon reads alice items', 'deny', () => getDoc(doc(anon, 'users/alice/items/d1')))
await check('unknown collection denied', 'deny', () => setDoc(doc(alice, 'users/alice/somethingNew/d1'), { x: 1 }))
await check('top-level config denied', 'deny', () => getDoc(doc(alice, 'config/aiProvider')))

await env.cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
