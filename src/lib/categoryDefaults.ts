// Default AI descriptions for built-in categories.
// These are shown as placeholder text in the category editor
// and included in the scan prompt even when the user hasn't added their own description.
// User descriptions are additive — they extend these, not replace them.

export const DEFAULT_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  cat_finance:  'Bills, invoices, bank statements, and payment confirmations. Includes energy suppliers, insurance, subscriptions, tax, HMRC, accountants, and any email mentioning amounts due or payment references.',
  cat_school:   'Emails from schools, nurseries, universities, tutors, and educational institutions. Includes term dates, fees, event notices, reports, and communications from teachers or admissions.',
  cat_home:     'Emails about your home or any properties you own or rent. Includes letting agents, estate agents, tradespeople (plumbers, electricians, builders), councils, and home insurance.',
  cat_hired:    'Emails from people you employ or hire — cleaners, gardeners, nannies, au pairs, tutors, personal trainers, and other domestic or personal service providers.',
  cat_health:   'Medical and health-related emails. Includes GP, dentist, optician, physio, and specialist appointments. NHS letters, private health insurance, prescriptions, and test results.',
  cat_travel:   'Travel bookings and confirmations. Includes flights, hotels, car hire, travel insurance, holiday packages, rail tickets, and booking reference numbers.',
  cat_work:     'Work and business emails. Includes clients, suppliers, colleagues, contracts, invoices to or from your business, and professional correspondence.',
  cat_it:       'Technology and software emails. Includes domain renewals, hosting providers, software subscriptions, app notifications, account security alerts, and IT support.',
  cat_drama:    'Social events, invitations, and personal correspondence. Includes party invitations, RSVPs, event tickets, and emails from friends about social plans.',
  cat_job:      'Job search and recruitment emails. Includes applications, interview invitations, recruiter outreach, job alerts, and correspondence with potential employers.',
  cat_other:    'Miscellaneous emails that do not fit clearly into another category.',
}

// Shorter version used as placeholder hint in the category editor UI
export const CATEGORY_DESCRIPTION_HINTS: Record<string, string> = {
  cat_finance:  'e.g. Add your accountant\'s name, specific bank, or HMRC reference — Keel already knows about bills and invoices.',
  cat_school:   'e.g. Add your school\'s name, specific teachers, or clubs — Keel already knows about school admin.',
  cat_home:     'e.g. Add your address, letting agent name, or specific tradespeople — Keel already knows about home emails.',
  cat_hired:    'e.g. Add names of your cleaner, gardener, or other regular hires.',
  cat_health:   'e.g. Add your GP surgery name, dentist, or any specialists you see regularly.',
  cat_travel:   'e.g. Add airlines or hotels you use regularly, or specific upcoming trips.',
  cat_work:     'e.g. Add your company name, key client names, or specific suppliers.',
  cat_it:       'e.g. Add specific domains you own, software you subscribe to, or your hosting provider.',
  cat_drama:    'e.g. Add names of close friends or specific social groups whose emails should land here.',
  cat_job:      'e.g. Add specific companies you\'re applying to or recruiters you\'re working with.',
  cat_other:    'Describe what you\'d like to catch here that doesn\'t fit elsewhere.',
}

// Work-specific default descriptions
export const WORK_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  cat_clients:   'Emails from clients and customers — enquiries, project updates, feedback, contracts, and correspondence about work you are delivering.',
  cat_suppliers: 'Emails from suppliers, vendors, and service providers — quotes, invoices, delivery notifications, and account management.',
  cat_finance:   'Business finance emails — invoices to and from your business, expense reports, accountant correspondence, bank notifications, and payment confirmations.',
  cat_hr:        'HR and people-related emails — job applications, contracts, payroll, employee queries, recruitment agencies, and HR administration.',
  cat_legal:     'Legal and compliance emails — contracts, NDAs, regulatory notices, company filings, solicitor correspondence, and compliance deadlines.',
  cat_projects:  'Project-specific emails — status updates, deliverables, timelines, and correspondence related to specific client or internal projects.',
  cat_marketing: 'Marketing and PR emails — campaign updates, press enquiries, agency correspondence, and brand or content related communications.',
  cat_it:        'IT and systems emails — software subscriptions, domain renewals, hosting, security alerts, and internal IT support.',
}
