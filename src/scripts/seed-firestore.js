// Keel — Firestore Seed Script
// Run this once to populate your account with sample data.
//
// HOW TO USE:
// 1. Sign in to Keel at localhost:3000
// 2. Open browser DevTools (Cmd+Option+I)
// 3. Go to the Console tab
// 4. Paste this entire script and press Enter
//
// It will create categories and items in your Firestore account.

(async () => {
  // Get Firebase from the window (Next.js exposes it via the app)
  const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js')
  const { getFirestore, collection, doc, setDoc, serverTimestamp, Timestamp } =
    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
  const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js')

  const firebaseConfig = {
    apiKey:            'AIzaSyAV7KMPRDE-taYyNMKLN1XR4SfMZ6L1dIY',
    authDomain:        'keel-6921a.firebaseapp.com',
    projectId:         'keel-6921a',
    storageBucket:     'keel-6921a.firebasestorage.app',
    messagingSenderId: '730461400810',
    appId:             '1:730461400810:web:eb84bbb0ec098680adb193',
  }

  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
  const db   = getFirestore(app)
  const auth = getAuth(app)
  const uid  = auth.currentUser?.uid

  if (!uid) {
    console.error('❌ Not signed in. Sign in first then run the seed script.')
    return
  }

  console.log(`✅ Signed in as ${auth.currentUser.email} (${uid})`)
  console.log('🌱 Seeding Firestore...')

  const now = new Date()
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)
  const daysAhead = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000)

  // ---- CATEGORIES ----
  const categories = [
    { id: 'cat_finance', name: 'Finance & Bills',    icon: 'banknote',    order: 1 },
    { id: 'cat_school',  name: 'School & Education', icon: 'graduation',  order: 2 },
    { id: 'cat_home',    name: 'Home & Property',    icon: 'home',        order: 3 },
    { id: 'cat_hired',   name: 'Hired Help',         icon: 'users',       order: 4 },
    { id: 'cat_health',  name: 'Health',             icon: 'heart',       order: 5 },
    { id: 'cat_travel',  name: 'Holidays & Travel',  icon: 'plane',       order: 6 },
  ]

  for (const cat of categories) {
    await setDoc(doc(db, `users/${uid}/categories`, cat.id), {
      categoryId: cat.id,
      name:       cat.name,
      icon:       cat.icon,
      parentId:   null,
      order:      cat.order,
      archived:   false,
      archivedAt: null,
      itemCount:  0,
      createdAt:  Timestamp.fromDate(daysAgo(30)),
      updatedAt:  Timestamp.fromDate(now),
    })
    console.log(`  📁 Created category: ${cat.name}`)
  }

  // ---- ITEMS ----
  const items = [
    {
      id: 'item_bt',
      categoryId: 'cat_finance', categoryName: 'Finance & Bills',
      senderEmail: 'billing@bt.com', senderName: 'BT Group',
      subject: 'Your BT bill is ready — account ending 4821',
      aiSummary: 'BT requesting payment of £45.99 due 2 May.',
      status: 'awaiting_action',
      aiImportanceScore: 0.92,
      receivedAt: daysAgo(3),
    },
    {
      id: 'item_thames',
      categoryId: 'cat_finance', categoryName: 'Finance & Bills',
      senderEmail: 'billing@thameswater.co.uk', senderName: 'Thames Water',
      subject: 'Your water bill — April 2026',
      aiSummary: 'Thames Water bill for April. £88.00 due 15 May.',
      status: 'awaiting_action',
      aiImportanceScore: 0.75,
      receivedAt: daysAgo(7),
    },
    {
      id: 'item_sportsday',
      categoryId: 'cat_school', categoryName: 'School & Education',
      senderEmail: 'admin@stmarysschool.co.uk', senderName: "St Mary's School",
      subject: 'Sports Day — RSVP requested by 30 April',
      aiSummary: "Invitation to Year 6 Sports Day on 1 May. RSVP by 30 April.",
      status: 'awaiting_action',
      aiImportanceScore: 0.88,
      receivedAt: daysAgo(2),
    },
    {
      id: 'item_trip',
      categoryId: 'cat_school', categoryName: 'School & Education',
      senderEmail: 'admin@stmarysschool.co.uk', senderName: "St Mary's School",
      subject: 'Year 6 end of year trip — permission form',
      aiSummary: 'Permission form needed for the Year 6 Science Museum trip on 15 May.',
      status: 'new',
      aiImportanceScore: 0.78,
      receivedAt: daysAgo(0),
    },
    {
      id: 'item_sarah',
      categoryId: 'cat_school', categoryName: 'School & Education',
      senderEmail: 'sarah@smitchelltutor.co.uk', senderName: 'Sarah Mitchell',
      subject: 'Invoice #014 — April tutoring sessions',
      aiSummary: 'Invoice for 4 tutoring sessions in April. Total £160 due end of month.',
      status: 'awaiting_action',
      aiImportanceScore: 0.72,
      receivedAt: daysAgo(5),
    },
    {
      id: 'item_dave',
      categoryId: 'cat_home', categoryName: 'Home & Property',
      senderEmail: 'jason@gmail.com', senderName: 'You',
      subject: 'Re: Boiler service quote — any availability?',
      aiSummary: 'You asked Dave for a boiler service quote and availability in May. No reply in 14 days.',
      status: 'awaiting_reply',
      aiImportanceScore: 0.65,
      importanceFlag: true,
      receivedAt: daysAgo(14),
    },
    {
      id: 'item_maria',
      categoryId: 'cat_hired', categoryName: 'Hired Help',
      senderEmail: 'maria@cleaningservice.co.uk', senderName: 'Maria (Cleaner)',
      subject: 'Re: Confirmed Monday 5 May — usual time',
      aiSummary: 'Maria confirmed she will clean on Monday 5 May at the usual time.',
      status: 'new',
      aiImportanceScore: 0.55,
      isRecurring: true,
      receivedAt: daysAgo(1),
    },
  ]

  for (const item of items) {
    await setDoc(doc(db, `users/${uid}/items`, item.id), {
      itemId:            item.id,
      messageId:         `msg_${item.id}`,
      threadId:          `thread_${item.id}`,
      accountId:         'account_primary',
      senderEmail:       item.senderEmail,
      senderName:        item.senderName,
      subject:           item.subject,
      receivedAt:        Timestamp.fromDate(item.receivedAt),
      categoryId:        item.categoryId,
      categoryName:      item.categoryName,
      subcategoryId:     null,
      subcategoryName:   null,
      status:            item.status,
      importanceFlag:    item.importanceFlag ?? false,
      aiImportanceScore: item.aiImportanceScore,
      snoozedUntil:      null,
      linkedOutboundId:  null,
      linkedItemId:      null,
      isRecurring:       item.isRecurring ?? false,
      fromTrackedReply:  false,
      trackedReplyId:    null,
      createdAt:         Timestamp.fromDate(item.receivedAt),
      updatedAt:         Timestamp.fromDate(now),
      resolvedAt:        null,
      aiSummary:         item.aiSummary,
    })
    console.log(`  📧 Created item: ${item.senderName} — ${item.subject.substring(0, 40)}`)
  }

  // ---- SIGNALS ----
  const signals = [
    {
      id: 'sig_bt_payment',
      itemId: 'item_bt', type: 'payment',
      description: 'BT bill — £45.99',
      detectedDate: daysAhead(4),
      detectedAmountPence: 4599, currency: 'GBP',
      calendarStatus: 'on_cal',
    },
    {
      id: 'sig_thames_payment',
      itemId: 'item_thames', type: 'payment',
      description: 'Thames Water — £88.00',
      detectedDate: daysAhead(17),
      detectedAmountPence: 8800, currency: 'GBP',
      calendarStatus: 'not_on_cal',
    },
    {
      id: 'sig_sportsday_rsvp',
      itemId: 'item_sportsday', type: 'rsvp',
      description: 'RSVP by 30 Apr',
      detectedDate: daysAhead(2),
      detectedAmountPence: null, currency: null,
      calendarStatus: null,
    },
    {
      id: 'sig_sportsday_event',
      itemId: 'item_sportsday', type: 'event',
      description: 'Year 6 Sports Day',
      detectedDate: daysAhead(3),
      detectedAmountPence: null, currency: null,
      calendarStatus: 'not_on_cal',
    },
    {
      id: 'sig_trip_event',
      itemId: 'item_trip', type: 'event',
      description: 'Science Museum trip',
      detectedDate: daysAhead(17),
      detectedAmountPence: null, currency: null,
      calendarStatus: 'not_on_cal',
    },
    {
      id: 'sig_sarah_payment',
      itemId: 'item_sarah', type: 'payment',
      description: 'Tutoring invoice — £160',
      detectedDate: daysAhead(3),
      detectedAmountPence: 16000, currency: 'GBP',
      calendarStatus: null,
    },
    {
      id: 'sig_dave_awaiting',
      itemId: 'item_dave', type: 'awaiting',
      description: 'Awaiting quote — 14 days',
      detectedDate: null,
      detectedAmountPence: null, currency: null,
      calendarStatus: null,
    },
    {
      id: 'sig_maria_event',
      itemId: 'item_maria', type: 'event',
      description: 'Cleaner — Maria',
      detectedDate: daysAhead(7),
      detectedAmountPence: null, currency: null,
      calendarStatus: 'on_cal',
    },
  ]

  for (const sig of signals) {
    await setDoc(doc(db, `users/${uid}/signals`, sig.id), {
      signalId:          sig.id,
      itemId:            sig.itemId,
      accountId:         'account_primary',
      type:              sig.type,
      detectedDate:      sig.detectedDate ? Timestamp.fromDate(sig.detectedDate) : null,
      detectedAmountPence: sig.detectedAmountPence,
      currency:          sig.currency,
      description:       sig.description,
      calendarStatus:    sig.calendarStatus,
      calendarEventId:   null,
      targetCalendarId:  null,
      status:            'active',
      createdAt:         Timestamp.fromDate(now),
      updatedAt:         Timestamp.fromDate(now),
    })
    console.log(`  📍 Created signal: ${sig.type} — ${sig.description}`)
  }

  // ---- OUTBOUND ----
  await setDoc(doc(db, `users/${uid}/outbound`, 'out_dave'), {
    outboundId:     'out_dave',
    messageId:      'msg_item_dave',
    threadId:       'thread_item_dave',
    accountId:      'account_primary',
    recipientEmail: 'dave@davesfixitall.co.uk',
    recipientName:  'Dave (Plumber)',
    subject:        'Boiler service quote — any availability?',
    aiSummary:      'Asked for a boiler service quote and availability in May.',
    categoryId:     'cat_home',
    categoryName:   'Home & Property',
    status:         'open',
    sentAt:         Timestamp.fromDate(daysAgo(14)),
    ageDays:        14,
    snoozedUntil:   null,
    repliedAt:      null,
    replyMessageId: null,
    linkedItemId:   'item_dave',
    graceExpiresAt: null,
    followUpCount:  0,
    lastFollowUpAt: null,
    createdAt:      Timestamp.fromDate(daysAgo(14)),
    updatedAt:      Timestamp.fromDate(now),
  })
  console.log('  📤 Created outbound: Dave (Plumber)')

  // ---- USER PREFERENCES ----
  await setDoc(doc(db, `users/${uid}/preferences`, 'settings'), {
    theme:               'harbour',
    darkMode:            'system',
    calendarDefault:     'account',
    primaryCalendarId:   null,
    calendarWindowDays:  10,
    quietLogDigest:      true,
    quietLogDigestDay:   1,
    quietLogDigestTime:  '09:00',
    gracePeriodHours:    48,
    connectedAccountCount: 1,
    updatedAt:           Timestamp.fromDate(now),
  })
  console.log('  ⚙️  Created preferences')

  console.log('')
  console.log('✅ Seed complete! Refresh the dashboard to see your data.')
  console.log(`   ${categories.length} categories · ${items.length} items · ${signals.length} signals · 1 outbound`)
})()
