# Changelog

All notable changes to VigaBSS. Releases are `v*` tags; `sudo redeploy`
deploys the newest one unless `VIGABSS_CHANNEL=main` is set in `.env.prod`.

## Unreleased

- **Administration menu: everyday pages up front, the rest under
  Administration setup.** Administration now has five sidebar rows that
  reach all 23 of its pages, where 16 were only reachable through its
  overview: People and access (users, user groups, menu templates,
  security, API tokens, user tunnels), Organization (organizations,
  settings, SLA definitions, legal documents), Points of sale (resellers,
  cash bags), Audit and safety (audit logs, DSAR, backups, DR drill), and
  Administration setup, a page of cards for automation, integrations and
  messages, and the AI assistant. Menu templates is now a tab of People and
  access.
- **Compliance menu: three rows.** Its ten pages are grouped as CFDI and
  SAT, IFT, and Consumer and general, each with its pages as tabs. An
  organization outside Mexico still sees the one general page, by its own
  name.

- **Billing menu: everyday pages up front, the rest under Billing setup.**
  The Billing section now has six sidebar rows. Five hold what is opened
  daily, each with its pages as tabs: Invoices (invoices, credit notes,
  CFDI, adjustments), Payments (payments, cash reconciliation,
  transactions, recurring payments, payment problems), Collections (payment
  plans, disputes, refunds, chargebacks), Plans, and Reports (reports, tax
  reports, analytics, expenses). The sixth, Billing setup, opens a page of
  cards for what is configured once: taxes, the look of invoices, payment
  gateways, late fees and reminders, and CSV import. Nothing was removed:
  every page keeps its address and is still found by search.

## 0.1.0-alpha.41 — 2026-11-24

- **Billing dates no longer depend on the server's time zone.** Billing
  periods, invoice due dates, trial ends, payment-plan instalments,
  reminder stages, the "current month" of usage, rollover and reports, and
  asset depreciation were computed with the time zone of the machine the
  application ran on. In the product's container that is UTC and the
  results were right; on a machine in another zone the same code landed on
  other days (a period starting on the last day of the previous month) and
  could not find the row it had just written. All of it now uses the UTC
  calendar, so the result is the same everywhere. Nothing changes for an
  install running in the standard container.

- **CI: jobs run in UTC on self-hosted runners too.** A runner in another
  time zone failed a real-database billing test that passes on
  GitHub-hosted machines, which are in UTC like the application's
  container.
- **Test: the DR runbook page waits longer for its lazily loaded part.** On
  a busy machine it took just over the default second and failed.

- **CI: the database jobs can run on self-hosted runners.** They no longer
  bind MySQL to a fixed port, so two can share a machine, and they take a
  self-hosted runner when `CI_SELF_HOSTED_RUNNERS` is 3 or 4. The runners
  need Docker for these.
- **CI: the number of test workers on a self-hosted runner is a setting.**
  The repository variable `CI_SELF_HOSTED_TEST_WORKERS` sets how many
  backend test suites run at once there; without it the number is 12.
- **CI: two self-hosted runners on one machine no longer break each
  other.** Both set up pnpm in the same folder of the shared home directory
  and cleared it on every run, so jobs running at the same time failed.
  Each runner now uses its own folder.

## 0.1.0-alpha.40 — 2026-11-24

- **Fixed: a menu template could not be given to anyone.** Choosing user
  groups or people for a template was refused with "a user group in the
  list does not exist", and the groups that never see the sidebar were
  still offered. Lists were handed to the database in a form its prepared
  statements do not expand, so the checks matched nothing. Giving a
  template to a group that does not use the sidebar is now refused too.

- **CI: backend tests use the self-hosted runner's cores.** The test step
  ran three suites at a time everywhere, a number chosen for GitHub's
  4-core machines; on a self-hosted runner it now runs twelve. The
  dependency cache is no longer downloaded there either.

## 0.1.0-alpha.39 — 2026-11-24

- **Menu templates has its own row under Administration.** It was only
  reachable through the Administration overview, search or a pin.
- **A template's group list shows only groups that use the sidebar.**
  Carriers, collectors and resellers work in their own apps and never see
  the staff sidebar, so a menu template could do nothing for them; they are
  no longer offered when choosing who gets a template.

- **CI can use the owner's own runners.** The repository variable
  `CI_SELF_HOSTED_RUNNERS` says how many self-hosted runners are online: at
  1 the backend test job runs on one, at 2 the frontend test job too, for
  pushes and for pull requests from branches of this repository. Pull
  requests from forks always run on GitHub-hosted machines. Setting it to 0
  or removing it sends everything back to GitHub.

## 0.1.0-alpha.38 — 2026-11-24

- **A menu of your own.** Anyone can arrange the sidebar into groups they
  name, holding the pages they use, from any section. A star in the top bar
  pins the open page into a group (or a new one), and "Edit my menu" at the
  bottom of the sidebar opens the full editor to rename, reorder and remove.
  With a menu of your own the sidebar shows your groups, and the standard
  menu folds under "All pages"; search still reaches everything.
- **Menu templates for job roles and people.** Under Administration, Menu
  templates lets an administrator prepare a menu once and give it to user
  groups or to individual people. A person's own template comes before
  their group's. A template can be locked so the people who get it cannot
  change their menu; otherwise each person can adjust their own copy and go
  back to the template at any time. New permission `menu_templates.manage`,
  held by administrators.
- **Menus never change what anyone can open.** A menu only stores page
  addresses. A page appears in someone's menu only if their own permissions
  already open it, the pickers offer only such pages, and every existing
  access check is unchanged. Migration 031.

- **Network menu: everyday pages up front, the rest under Network setup.**
  The Network section now has six sidebar rows. Five hold what is opened
  daily, each with its pages as tabs: Monitoring, Topology Map, Subscribers
  online, Equipment (sites, devices, NAS, OLT, ONU, wireless, CPE) and IP
  addresses. The sixth, Network setup, opens a page of cards for what is
  configured once and rarely revisited (polling, alerts, device
  configuration, fibre plant, customer equipment profiles, sessions and
  speed, addressing, equipment tools, VPN access), each card saying in a
  line what it is for. A setup page shows the other pages of its card as
  tabs and a link back to Network setup. No tab strip has more than seven
  tabs, so the "More" menu is gone. Nothing was removed: every page keeps
  its address and is still found by search. Technician map moved to Field
  Work.

## 0.1.0-alpha.37 — 2026-11-24

- **The Network badge counts its groups.** The number beside Network in the
  sidebar, and its "View all" row, showed 55 (every page inside the groups)
  and now show 12, the groups themselves.

- **Fixed: clicking the highlighted Network row jumped to the previous
  tab.** While a page of a group was open, the group's sidebar row still
  pointed at the page opened before it. The row now points at the page
  being viewed.

## 0.1.0-alpha.36 — 2026-11-24

- **Network menu: related pages are grouped under tabs.** The Network
  section's 55 pages are grouped into 12 sidebar rows (Monitoring, Topology
  Map, Subscribers online, Equipment, Fibre, Wireless, Customer equipment,
  IP addresses, Speed and suspension, Polling and alerts, Device
  configuration, My VPN Tunnels). Opening a row shows its pages as tabs
  above the page, so moving between, say, OLT, ONU, PON ports and fibre
  plant is one click. A long group keeps its first tabs visible and puts the
  rest under "More"; a phone gets a drop-down. Each row reopens on the page
  used last in that browser. No page was removed or changed: every page
  keeps its address, bookmarks and search still work, and a person sees only
  the tabs their permissions allow. The Network overview page now shows the
  same groups as the sidebar.

## 0.1.0-alpha.35 — 2026-11-24

- **The network tree can be shown as a chart.** The Tree tab has a List /
  Chart switch. The chart draws each main NAS on the left and what it feeds
  in columns to the right, as boxes joined by lines; each line takes the
  colour of its health, so a fault and everything behind it show at a
  glance. Branches open and close, and in a tree of more than 40 pieces only
  the branches with a problem start open. Clicking a box shows what is wrong
  with it. Moving a piece and setting up its line stay in the list. The
  chart is the first view on a wide screen and the list on a phone; the
  choice is remembered per browser.

## 0.1.0-alpha.34 — 2026-11-24

- **Fixed: lines on the Network map stayed grey.** A line was coloured only
  when it was first drawn, before its health had loaded, so it never turned
  yellow or red unless the Tree tab had been opened first. Lines now follow
  their health like the markers do.

## 0.1.0-alpha.33 — 2026-11-23

- **Fixed: every map had a grey background.** The service worker intercepted
  the map tile requests to the tile provider, its own fetch was refused by
  the site's security policy, and it answered each tile with a cached page
  instead of an image. It now leaves requests to other sites to the browser.
  It also no longer answers a failed image, script or style with the cached
  page; only a page falls back to it. Browsers pick up the corrected worker
  on their next visit; a map already open needs one reload.

## 0.1.0-alpha.32 — 2026-11-23

- **A reopened incident does not write twice to the same customer.** A
  customer who was already told a fault was resolved is not written to again
  when the reopened incident is closed a second time, unless they contacted
  us again while it was open. A closing message still waiting for approval
  when its incident reopens is withdrawn, since it says the fault was
  resolved.

- **Fixed: an incident's "contracts behind it" missed wireless customers.**
  Customers connected to a sector are now counted through what the sector
  has seen in the last day, and the count is refreshed each time the fault
  is seen, so an incident opened before its customers were known no longer
  stays at zero.
- A contract's connection check no longer lists a hop as "not measured" when
  its line was measured.
- The message written for customers when an incident is closed no longer
  carries a place or direction word taken from an equipment name.

- **Fixed: equipment that was never polled showed as "off" (red).** Every
  device starts with the status "offline" until polling has looked at it, and
  the network tree read that as an outage. Unmonitored equipment turned red,
  the watch opened an "offline" incident for it, and a customer's connection
  check could conclude that our network was down. "Offline" now only counts
  once polling has detected it (three failed polls in a row); equipment that
  was never polled is grey, "not measured".

## 0.1.0-alpha.31 — 2026-11-23

- **A draft closing message is reviewed in the reviewer's own language.**
  The person approving a draft in the Incidents tab reads it in the language
  they use VigaBSS in, with what the customer will receive shown under it in
  the customer's language. Sent unchanged, the customer gets the message
  exactly as first written. If the reviewer changes the text, "See what the
  customer gets" shows their version in the customer's language, and only
  then can it be sent; what is sent is exactly the text they read. Editing
  again asks for a new preview. If the translation cannot be done, nothing
  is sent. Each language is translated once per draft.
  (migration 030)

- **The message after an incident is closed is written in each customer's
  own language.** It uses the language the customer wrote in when they
  reported the fault, whatever language that is, and falls back to the
  language of their profile when there is nothing they wrote. Before, every
  customer got the organization's default language. The fixed neutral notice
  (used when the comment explains nothing or no AI provider is available)
  exists in English, Spanish and Portuguese only.

- **Network incidents for technicians, and the assistant checks the whole
  path.**
  - **Incidents tab** (Topology Map). The network tree is judged every five
    minutes and each faulty line or piece of equipment gets one incident:
    what is wrong with the numbers, since when, how many contracts are
    behind it and which customers reported it. Its details show the pattern
    over the last seven days (comes back every evening, or continuous) and
    whether that points to capacity or to a repair.
  - **An incident is not closed by the fault clearing.** A link that
    saturates in the evening is fine at night; the incident stays open and
    shows "fine right now". Only a technician closes it, and must write what
    was done. For a week after, the same fault reopens it.
  - **Nothing is sent to customers by the watch.** When a technician closes
    an incident, the comment is rewritten into a professional message for
    the customers who reported that fault, and only them. It names no
    equipment and adds nothing the comment does not say; a comment that
    explains nothing gives a short neutral notice. It is sent when the
    assistant is allowed to send by itself on that channel; otherwise it
    waits in the incident as a draft to read, edit and send or not send.
  - **The support assistant** now checks the customer's whole path when they
    report a problem. If the fault is in our network it says so in plain
    words, links the customer to the incident and opens no technician visit
    for them, so one fault is one incident. If the customer is using all of
    their plan it explains that. Every check is kept as evidence and added
    to the ticket when one is opened.
  - **"Keep as evidence"** on a contract's Connection check stores what was
    measured at that moment.
  (migration 029)

- **Connection check on a contract.** A contract's page has a "Connection
  check" that walks every hop from the customer's equipment up to the main
  NAS (radio, sector, links and routers for wireless; ONU, OLT and what is
  above it for fibre) and shows each in the network tree's colours. It ends
  with one sentence on where a fault is: our network above the sector or
  OLT, our access equipment, the link between the customer and us, the
  customer's equipment, or nothing failing because the customer is using all
  of their plan. What could not be checked is listed by name, never assumed
  good.

- **The network tree shows what is good, degraded or off.** Each line of the
  tree, and each piece of equipment, is green, yellow, red, or grey when it
  is not measured. What is wrong is written under the row with the numbers
  behind it, and the Network map draws its lines and markers in the same
  colours. Colours refresh every minute from the SNMP poller's readings.
  - **Radios (point-to-point and sectors)** are judged on their traffic
    against what the radio can carry right now, read from the radio, so a
    link that slows down in bad weather is judged against its real capacity.
    Airtime is judged where the radio reports it, plus SNR and CCQ. A
    saturated sector lists the subscriber radios carrying the most.
  - **Fibre** turns yellow when its received optical power drops suddenly
    against its own normal of the last seven days, even while traffic still
    passes, or when the level is near the floor.
  - **Any line** with a known port turns red when the port is down, and
    yellow on traffic near its capacity or on climbing port errors.
  - **Equipment** turns yellow on CPU, memory, temperature or a low battery.
  - "Line…" on a row chooses which polled port faces what feeds it and the
    line's capacity. "Limits for the colours" shows every limit and lets
    someone who may change settings adjust them.
  Equipment that is not polled is grey, never green. (migration 028)

- **The network as a simple tree, with a map for each main NAS.** Topology
  Map has two new tabs.
  - **Tree** shows what feeds what: a main NAS at the top and, in branches
    under it, the sub-NAS routers, point-to-point and point-to-multipoint
    links, OLTs, switches, battery monitors and anything else. An ISP with
    more than one network or origin marks more than one NAS as main and gets
    a tree for each, with a picker to look at one. Equipment is placed, moved
    or taken out with a button on its row; what has no place yet is listed
    under the trees. A piece of equipment has one parent, a main NAS has
    none, and a move that would make a loop is refused.
  - **Network map** is one map per main NAS: everything in its tree, placed
    by clicking the equipment and then its spot, with a line from each piece
    to what feeds it.
  - "Battery monitor" is a new device type.
  (migration 027)

- **Links can be drawn on the network map.** "Add a link" on the Topology Map
  lets you click two markers and say what joins them (fibre, wireless,
  copper, virtual or other, with an optional capacity). Clicking a link
  offers to remove it. Before, links were only listed and there was no way to
  create one. A NAS router can be either end: the first time a NAS is linked
  it becomes a device on the map at its site, and from then on it is placed,
  linked and shown like any other equipment (migration 026).

- **NAS routers appear on the topology map.** They were missing because they
  are stored separately from other devices. A NAS is drawn at its site, with
  a blue outline, and its popup names its make and site. A NAS with no site,
  or whose site has no coordinates, is listed under the map with what to set.
- **The NAS type is chosen from a list** (MikroTik, Cisco, Juniper, Huawei,
  Ubiquiti, Other) instead of typed. A value typed before stays selectable.

- **The Network section is reorganised.** Its 54 pages are grouped by what
  you are doing instead of by protocol name. The Network page now has ten
  groups: Monitoring, Subscriber sessions, Routers and devices, Fibre (FTTH),
  Wireless (WISP), Customer equipment (CPE), IP addresses, Speed and
  suspension, Device configuration, and Polling and alerts. The sidebar shows
  the everyday pages under headings (Monitoring, Subscribers online,
  Equipment, Addresses, My access), and OLT Management is now in the sidebar
  beside Devices and NAS. Sites moved here from Field work and is now called
  "Network sites": it is the first entry under Equipment, since towers, POPs
  and nodes are where the equipment lives. No page was removed and addresses
  are unchanged.
- **An OLT can be added from the OLT page.** OLT Management → Live OLT has an
  "Add an OLT" button (name, model, management address, SNMP community), as
  NAS Devices has for a NAS. Before, an OLT had to be created on the Devices
  page as a device of type OLT. With no OLT yet, the form is shown straight
  away.

- Tests: placeholder Stripe keys and webhook secrets are assembled when the
  test runs, so they are no longer reported as leaked secrets by GitHub
  secret scanning, and a check keeps secret-shaped literals out of the
  source, tests and docs.

## 0.1.0-alpha.30 — 2026-11-23

- **FTTH speed is enforced on the OLT.** A contract whose ONU was authorised
  from VigaBSS is rate-limited by the OLT, and RADIUS no longer sends it a
  speed limit, so the MikroTik creates no queue for it. A plan change on such
  a contract sets the new speed on the OLT automatically. A contract marked
  FTTH whose ONU was not authorised from VigaBSS keeps its limit at the
  MikroTik, so nobody is left without a limit. Fair-use and soft-suspension
  throttles still apply at the MikroTik; when one ends the session is dropped
  so it signs in again without the throttle. Time-based speed windows do not
  apply to these contracts. Suspension for non-payment is unchanged.

- **Provisioning ONUs on a Huawei OLT.** From the Live OLT tab you can now
  authorise an ONU that is waiting on a PON port (for a contract, whose plan
  gives the speeds, or with speeds typed in), change its speed, switch it off
  or on, and remove it. Speeds are applied on the OLT as rate-limit tables
  that VigaBSS creates once per speed and reuses. Every change first shows the
  exact commands; nothing is sent until "Send to the OLT" is pressed. If the
  OLT refuses a command the run stops there, and what was sent and answered
  is shown and kept in an operation log. Each OLT has a small set of
  provisioning settings (line and service profile, VLAN, GEM port), which
  must already exist on the OLT (migration 025). **Not yet tried on a real
  OLT.**
- Docs: `docs/huawei-eotdr-capture.md`, a form for capturing eOTDR output
  from a real OLT so eOTDR readings can be implemented.

- **Automatic OLT monitoring over SNMP.** VigaBSS can read every OLT that has
  SNMP enabled every 10 minutes and remember each ONU's state, distance and
  signal per PON port. The Live OLT tab has the switch for it ("Read every
  OLT automatically", install operator) and a new "Fibre status by PON port"
  list that shows, for each port, whether a break is suspected and within
  what distance, from the last read and without contacting the OLT. With it
  on, the fibre check always has recent distances to work from. **Not yet
  tried on a real OLT**: the SNMP object numbers come from published copies
  of Huawei's xPON MIB (migration 024 corrects the scheduled task's
  description).

- **Fibre break check on a PON port.** Reading a PON port in the Live OLT tab
  now says whether the fibre looks cut and how far away. It uses what the OLT
  already reports: ONUs that lost their light signal (as opposed to mains
  power), and the distance each ONU had while it was online, which VigaBSS
  now remembers on every read (migration 023). It tells apart a break on the
  main fibre (every ONU dark), on a branch (several dark) and a single drop,
  and states that the break is no farther than the nearest ONU that lost
  signal. That is an upper limit, not a measurement: the exact distance needs
  an OTDR, and reading eOTDR transceivers is not implemented yet.

- **PON ports can be marked as having an eOTDR transceiver.** The PON port
  form has a "Transceiver with eOTDR" checkbox and the port list shows an
  eOTDR badge (migration 022). This records which ports carry one; reading
  eOTDR measurements from the OLT is not implemented yet.

- **Technology transition with a newly signed contract.** A contract in
  service has a "Change technology" action. It creates a new contract for the
  other technology (WISP or FTTH), linked to the current one. The new contract
  goes through the normal activation steps, including the client's signature.
  The current contract keeps working until the new one is activated and is
  terminated at that moment; cancelling the new contract leaves it untouched.
  Both contract pages show the link (migration 021).
- **IP pools have an access technology.** A pool is marked WISP, FTTH or both
  (IP pool form; default both). A new contract's PPPoE account takes a pool
  of the contract's own technology, preferring a pool for exactly that
  technology over one that serves both, so fibre and wireless subscribers can
  have separate address ranges (migration 020).
- **Huawei OLT driver, read operations (MA5800 / EA5800).** Network → OLT
  Management has a "Live OLT" tab. For an OLT device you save how VigaBSS logs
  in to its command line over SSH (management address, user, password), test
  the connection, and read straight from the OLT: software version and
  boards, ONUs that are plugged in but not yet authorised, and the ONUs of a
  PON port with state, signal level and distance. Nothing on the tab changes
  the OLT. The password is stored encrypted and never shown again; the OLT's
  SSH key is saved on the first connection and checked on every later one
  (migration 019). **Not yet tried on a real OLT**: it is written from
  Huawei's command reference and tested against a simulated OLT, so each
  result can also show the text the OLT printed. Authorising ONUs and setting
  speeds on the OLT come next.

- **Access technology on plans and contracts (WISP / FTTH).** A plan is marked
  WISP, FTTH or both. A contract is created for one technology: the plan's,
  or, for a plan offered over both, the one chosen on the new-contract form.
  It is fixed after that. A contract cannot be moved to a plan of the other
  technology; changing between WISP and FTTH is done with a new contract. The
  contract page shows its technology. Existing plans and contracts stay WISP
  (migration 018).

- **The weekly VoIP range refresh is switched on in the app.** Network → NAS
  has a "Refresh VoIP ranges every week" switch (install operator; others see
  its state). It used to need `VOIP_RANGES_ENABLED=true` in the server's
  environment plus a scheduled task the web GUI could not enable. The
  variable is no longer read; migration 017 corrects the task's description.
- **VoIP priority can be removed from a router.** The VoIP button on a NAS is
  now a small menu: refresh the address list, or remove VoIP priority, which
  deletes the rules, the priority queue and the
  addresses VigaBSS added for it, after a confirmation. Seeding was add-only,
  so until now it could only be undone by hand on the router. Entries someone
  added to the list by hand are kept.

- CI: the full-install check waits for the newest release's image to be
  published before installing. On a release tag it used to start before that
  image existed and fail, although the release itself was fine.

## 0.1.0-alpha.29 — 2026-11-23

- **Client portal: "Pay another way".** A subscriber who started a payment
  (for example took an OXXO voucher) and then wants to pay by card can now
  cancel it from the invoice. Before, Pay Now sent them back to the finished
  Stripe page for a day, and the voucher stayed payable after a new checkout
  was opened, so an invoice could be paid twice. The button warns that the
  voucher will stop working, voids it at Stripe, and opens a new checkout. A
  payment that has already arrived or is being processed is never cancelled.
  Stripe only; no new webhook event is needed.
- **Client portal home: autopay status with its action.** The home page shows
  whether autopay is on (and the card it uses) with one button: set it up when
  it is off, turn it off when it is on. Turning it off now asks for
  confirmation. The Account page shows the same card.
- **Client portal: the Data packs tab only appears when it applies**, that is
  when the subscriber's plan has a data allowance or they still hold a pack.
  For a subscriber with several services, data packs and the allowance now use
  the service whose plan has an allowance instead of an arbitrary one.
- Client portal: the Help and Account menu entries are now translated into
  Spanish and Portuguese (they were English in every language).
- **A WireGuard client that opens this install's own site is now seen with its
  own tunnel address.** A full-tunnel client used to arrive as the Docker
  gateway address, the same for every client, so the admin IP allowlist could
  only allow all VPN clients or none, and login IP blocks, rate limits and the
  audit log could not tell them apart. The hub now hands such a connection to
  a forwarder in the app, which passes the client's tunnel address (IPv4 and,
  with `WG_IPV6`, IPv6) to the web server. To allow one VPN device on the admin
  IP allowlist, add its tunnel address. Needs the bundled nginx; with another
  web server, or until nginx has loaded the new `nginx.conf`, clients reach
  the site as before. Nothing to configure.
- **A refused administrator is told which address was refused.** The admin IP
  allowlist's "access denied" message now names the address the server saw.
  The page that shows "your current IP" is behind the same check, so there
  was no way to learn which address to add.
- The admin IP allowlist's validation message no longer says IPv4 only; IPv6
  addresses and ranges were already accepted.
- **Ubuntu 24.04 LTS and 26.04 LTS are the supported servers, and both are
  tested.** CI now runs the installer on each release on every change: its
  package step in a clean image of the release, and a complete install on a
  machine of it, through to a stack that answers over HTTPS. A change that
  breaks either release fails a check. The installer has a new
  `INSTALL_DEPS_ONLY=1` mode that installs only what the server needs (curl,
  Git, OpenSSL, Docker, Docker Compose v2) and stops.
- **A first install no longer fails on a server whose root account creates
  files writable by everyone.** MySQL ignores a world-writable config file, so
  on such a server the database started without its settings and the first
  migration stopped with a binary-logging error. The installer and `redeploy`
  now check files out with normal permissions, and the installer corrects an
  existing checkout. Found by the new install check.
- The installer no longer prints two harmless "command not found" lines while
  writing `.env.prod`.
- **CFDI page: sortable columns, newest first.** The column headers of the
  CFDI list are now clickable and sort the whole list (ID, type, receptor,
  total, date, status, PAC); a second click reverses the order. The list
  opens with the newest documents first, where it used to show the oldest.
  Sorting keeps the status and type filters and returns to the first page.
- **CFDI page readable in dark mode.** The table, the status and type filter
  buttons, the page switcher and the stamp and cancel dialogs used fixed
  light colours; they now follow the theme. An empty result reads
  "Page 1 / 1" where it read "1 / 0".
- Sortable column headers on every list no longer force a dark grey label,
  which was hard to read in dark mode.
## 0.1.0-alpha.28 — 2026-11-22

- **Whisper and OpenRouter's other speech-to-text models can transcribe voice
  notes.** The voice-note model picker on an OpenRouter provider now also
  lists OpenRouter's dedicated transcription models (Whisper, GPT Transcribe,
  Voxtral and others), marked "Speech to text" with their price per minute of
  audio where OpenRouter prices them that way. Before, only chat models that
  accept audio were offered, because the model list was fetched without them.
  A dedicated model is called through OpenRouter's transcription service; a
  chat model keeps being asked to write down what it hears. The cost OpenRouter
  reports for a transcription is what counts against the AI budget.
## 0.1.0-alpha.27 — 2026-11-22

- **Dropdowns and fields that were unreadable in dark mode.** The request type
  dropdown under Account → New request in the customer portal, and fields on
  several other screens (portal chat and help articles, device and site
  details, PAC providers), used colour names the theme never defined. The
  browser then drew its default light background under the dark theme's light
  text. Those names now follow the theme, and a test fails when a screen uses
  a colour name that is defined nowhere.
- **A model picker for OpenRouter providers.** The model field was a text box
  with the browser's autocomplete over several hundred ids. It is now a list
  you can search, limit to free models and sort cheapest first, showing each
  model's price per million tokens and context size, with the time the list
  was last fetched from OpenRouter and a refresh button. A model id can still
  be typed by hand.
- **The voice-note model is picked from the models that accept audio.** On an
  OpenRouter provider the "Voice note model" field uses the same picker,
  limited to models OpenRouter marks as accepting audio. One provider can so
  use one model for text and another for voice notes.
- **The provider that transcribes voice notes is chosen.** The Providers table
  has a "Voice notes" column: select which OpenAI or OpenRouter provider
  transcribes them. Before, the first one enabled was used and nothing showed
  which. Unset, that automatic choice still applies. Migration 016 adds
  `ai_policies.voice_provider_id`.
- **"Voice notes: ready / not ready, and why"** on the WhatsApp and Providers
  screens: the provider and model in use, or the one thing that stops them
  (assistant off, WhatsApp channel off, no OpenAI/OpenRouter provider, budget
  used up, WhatsApp not connected). The bot's "I couldn't listen" reply is the
  same whatever the cause.
- **The WhatsApp settings screen warns when replies are not being
  delivered.** When Meta refuses a reply, the screen shows a warning with how
  many failed, since when and Meta's own message, and says what to do when the
  access token was rejected (the usual cause: a temporary token that expired).
  It clears by itself with the next reply that goes out, or when a new token
  or number is saved. Before, a rejected token was only visible in the server
  log while customers got no answer.
- **The model that transcribes voice notes is chosen on the provider.** An
  OpenAI or OpenRouter provider has a "Voice note model" field under AI
  Support → Settings → Providers. Left empty it uses the default
  (`gpt-transcribe` for OpenAI, `google/gemini-2.5-flash` for OpenRouter). The
  environment variables remain as a fallback, so nothing has to be set on the
  server.

## 0.1.0-alpha.26 — 2026-11-21

- **The WhatsApp bot answers voice notes.** A linked customer can send a
  voice note and gets the same text answer as if they had typed it; it also
  works as the answer inside a step ("sí, hazlo", "mañana en la tarde"). The
  note is transcribed with the organization's OpenAI or OpenRouter provider,
  so an organization that answers with Claude adds one of those under AI
  Support → Settings → Providers for this (it does not need to be the active
  one). OpenAI uses its speech-to-text model; OpenRouter has none, so there
  the audio goes to a chat model that accepts audio
  (`AI_TRANSCRIPTION_OPENROUTER_MODEL`, default `google/gemini-2.5-flash`).
  Requirements and limits:
  - Only with the AI assistant on for WhatsApp, only for linked numbers, and
    only through Meta's Cloud API.
  - The audio is fetched from Meta, sent to that provider and not stored; the
    transcript is kept with the inbound message.
  - Notes over 3 MB (several minutes) are not transcribed. When a note cannot
    be transcribed for any reason, the bot asks the customer to type.
  - Each transcription counts against the AI budget, at an estimated cost
    (`AI_TRANSCRIPTION_USD_PER_MINUTE`, default 0.006; the length is
    estimated from the file size). `AI_TRANSCRIPTION_MODEL` (default
    `gpt-transcribe`) sets the model. Migration 015 adds the `transcribe`
    usage type.
- **The portal chat answers from the customer's account.** When the AI
  assistant answers on the portal by itself (assistant on, portal channel on,
  mode "auto-send", a provider selected), the customer portal's chat is now
  answered by the support conversation engine, the one behind the WhatsApp
  bot and the Conversations tab. It reads the customer's account and
  connection and answers in a few sentences, where the chat used to open a
  ticket on the first message and reply with a long letter asking for details
  the system already has. A ticket, with the transcript, is opened only when
  the chat is handed to staff, and the conversation appears under AI Support →
  Conversations. Every other configuration is unchanged: a ticket per chat,
  and a draft kept for staff review is never shown to the customer.
  Migration 014 adds `portal_chat_sessions.support_conversation_id`.
- **The WhatsApp bot understands what customers write.** With the AI
  assistant on for WhatsApp, a linked customer no longer has to pick numbers:
  - "cuánto debo", "mi factura" or "quiero cambiar la clave del wifi" reach
    the right answer or start the right step, and balance, plan and invoice
    answers are worded for the question. A greeting gets a conversational
    greeting; the numbered menu appears when the customer types MENÚ or was
    not understood twice.
  - Inside a step the customer can answer freely: "el de la oficina" picks a
    service, "mañana en la tarde" gives the day and time of a visit in one
    message, "sí, hazlo" confirms a Wi-Fi password reset and "mejor no"
    cancels it.
  - The model only chooses among things the bot already offers (a capability,
    one of the listed services, a date, yes or no) and each answer is checked.
    Amounts, dates and payment links always come from the system: a reworded
    answer that changes a number or a link is discarded and the standard text
    is sent. Numbers still work, and with the assistant off, over budget or
    failing the bot behaves as before.
- **Tappable options on WhatsApp** (Meta Cloud API): the menu and the choice
  of service are lists, and confirming a Wi-Fi reset, the day of a visit
  (tomorrow / the day after) and its time are buttons. A tap is read like the
  typed answer. If Meta refuses the interactive form, the same reply is sent
  as text.
- The AI panel on a ticket (triage suggestions and the AI summary) is readable
  in dark mode. The summary box had a fixed light background behind the dark
  theme's light text.
- **One live/test switch for the whole install.** `INSTALL_MODE` in the
  server's environment file is `live` by default, and a production install
  sets nothing. Only the developer's demo or maintenance server sets
  `INSTALL_MODE=test`. Everything with a sandbox side follows it, and nobody
  chooses a sandbox per organization or per record any more:
  - **Payments:** a Stripe gateway accepts only a secret key from the
    install's side (`sk_live_…` on a live install, `sk_test_…` on a test one),
    and a Stripe webhook event from the other side is refused. The "sandbox /
    production" choice on a Stripe gateway is gone; the server reads it from
    the key. Other providers keep the label.
  - **SAT invoices:** a live install stamps and cancels only through
    production PACs, a test install only through sandbox PACs. The "Fiscal
    environment" selector on PAC Providers and the environment choice on each
    PAC are removed; a PAC gets the install's environment when it is created.
    The simulator PAC exists only on a test install. An organization that was
    still set to sandbox stamps in production after this update, and needs an
    active production PAC to stamp at all; its sandbox PAC rows stay but are no
    longer used. A CFDI is still cancelled in the environment that stamped it.
    (The simulator PAC can now actually be created from the screen: its
    placeholder address used to be refused by the outbound-address check.)
  - **Web interface:** a test install shows a flashing "DEV MODE" badge beside
    the version at the top left, and a notice on Payment Gateways, PAC
    Providers and the billing pages.
  - WhatsApp is not affected: Meta's test number and a real number use the
    same kind of credentials.
- **Payment gateways have a "Test connection" button** (Stripe): it asks
  Stripe whether the stored key works, without moving money.
- The list of Stripe events to subscribe to, shown on the gateway, now
  includes `charge.dispute.closed`. Without it a lost dispute was never
  recorded.
- The verify token of the WhatsApp webhook handshake is no longer written to
  the app log or the nginx access log. Meta sends it as a query parameter and
  it was logged in clear. If you connected WhatsApp on 0.1.0-alpha.25, choose
  a new verify token after upgrading.

## 0.1.0-alpha.25 — 2026-11-20

- **The support chat's replies can be written by the AI.** When the AI
  assistant is on for the channel, the chat (the Conversations tab and the
  WhatsApp bot) words each answer with the organization's model, for the
  customer's actual message and the conversation so far. The rule-based
  answer stays the only source of facts, and it is what the customer gets
  whenever the assistant is off, over budget or fails. A hand-off to a person
  and a request to confirm an action are never reworded.
  The "mask personal data" switch applies here as it does to ticket replies:
  emails, phone numbers, IP and MAC addresses are sent as placeholders and
  restored in the reply.
- **WhatsApp can be connected from the app.** AI Support → Settings →
  WhatsApp holds the Meta Cloud API connection (phone number ID, access
  token, app secret, verify token), shows the webhook URL to give Meta and
  has a connection test. Install operator only; the secrets are stored
  encrypted and never shown again. Values set in the server environment keep
  working and are used wherever the screen is left empty.
- WhatsApp (Meta Cloud API) calls use Graph API v26.0 by default. The
  previous default, v21.0, stops working on 21 January 2027.

- **The AI chat uses the connected model to understand a message.** It
  classified every message by keyword only, so anything outside its word
  lists counted as unclear and two unclear messages sent the conversation to
  a person, even with a working provider. Keywords are still tried first; when
  they cannot place a message, the organization's provider is asked.

## 0.1.0-alpha.24 — 2026-11-20

- **One AI Support page.** The two AI menu items are now one, "AI Support",
  with four tabs: Conversations, Knowledge Base, Settings (general, providers,
  phrase library, forbidden terms) and Metrics, which also shows the reply
  assistant's activity. The old settings address opens the Settings tab.
  NOC AI Insights moved to its own page under Network.

## 0.1.0-alpha.23 — 2026-11-20

- **The Anthropic connection works with current Claude models.** The model
  list in AI Reply Assistant → Providers offers Claude Haiku 5.5, Sonnet 5.5
  and Opus 5.5 (any model id can still be typed). Replies are no longer cut
  off by the token limit on models that think before answering, a refusal or
  a cut-off answer is treated as a failure instead of being sent as a reply,
  and cost is recorded with the real input and output prices; it was recorded
  as $0 for every current model.

- **An escalated AI chat's ticket shows the conversation.** The ticket said
  only which conversation it came from, so the agent could not see what the
  customer had written without finding the chat on another page. The ticket
  description now includes the reason and the chat so far.
- The two AI menu items are renamed to say what they are: **AI Reply
  Assistant** (settings for the reply drafts agents get) and **AI Customer
  Chat** (the chatbot's conversations, knowledge base and metrics).

- **What's New shows the real release notes.** The panel read a fixed list
  of six entries that was never updated, so no release ever appeared in it.
  It now shows the notes of each release, newest first, from the same
  changelog the releases are written from.

## 0.1.0-alpha.22 — 2026-11-20

- **Dependency updates, three with security fixes.** nodemailer 10.6.0
  (recipient-domain validation gaps), `ws` 8.23.0 (remote memory-exhaustion
  denial of service) and `dompurify` 3.4.18 (sanitizer bypass), plus Node
  24.22.3, refreshed Redis and nginx images, certbot 5.10.0 and smaller
  library updates.

- **Record Payment no longer overwrites an amount you have started typing.**
  The dialog fills the amount with the client's open balance once the
  invoices load. If they arrived after typing had begun, the typed amount was
  replaced, and keystrokes still on their way were appended to the balance.
  The amount is now filled only while the field is empty. The end-to-end
  smoke test waited on the same race and failed intermittently; it now waits
  for the invoices before typing.

- Development and test tooling: Playwright 1.65.1 (library and the e2e
  container image together), vite 6.4.6, supertest 7.3.2 and
  `@testing-library/user-event` 14.6.10. Dependabot no longer opens a
  separate PR for the Playwright image, which could never pass on its own.

- **One unreachable device no longer slows SNMP polling for the rest.**
  Devices were polled in groups of ten, and each group waited for its slowest
  device, so a device that did not answer held up the nine beside it and
  every group behind them for its whole timeout: about thirty unreachable
  devices were enough to make a full cycle take five minutes. Every device
  now runs in its own slot (`SNMP_POLL_CONCURRENCY`, default 10) and its
  result is recorded as soon as it is known. In a local simulation of 200
  devices with 10 not answering, a cycle went from 100 seconds to 10.
- **A device's SNMP timeout and retry settings are applied.** The values in a
  device or device-type polling config were stored but never used; every
  device got 5 seconds and one retry.
- The default SNMPv3 user name for a v3 device with none set is `vigabssv3`.

- **Every internal name now uses the product name.** Cookies and browser
  storage keys, the default database name and user, the WireGuard hub
  interface (`wg-vigabss`) and firewall table (`vigabss_wg`), the names and
  comments written to managed routers (`vigabss-*`), metric names, the
  container user, the Grafana dashboard files and the raw Kubernetes resource
  names. The installer and deploy scripts no longer accept the earlier
  spellings of their settings, install path or command. Everyone is signed
  out once after upgrading. An install made from an earlier alpha also needs
  two one-time fixes by hand: rename the SSO group-mapping role column to
  `vigabss_role`, and rename the hub key files in the WireGuard key volume to
  `wg-vigabss.key` / `wg-vigabss.pub` (otherwise the hub generates a new key
  and NAS tunnels must be re-provisioned).

- **Sorting works on the Overdue invoice filter.** Clicking a column header
  while the Invoices list was filtered to Overdue did nothing; the list now
  sorts by the chosen column. The default is still longest overdue first.

## 0.1.0-alpha.21 — 2026-11-10

- **WireGuard full tunnels can carry IPv6.** With `WG_IPV6=true` in
  `.env.prod`, each full tunnel gets an IPv6 address next to its IPv4 one
  and reaches the IPv6 internet through the server. It is off by default.
  The server needs working IPv6 and Docker 27 or newer, and the first deploy
  after turning it on recreates the app's Docker network. A tunnel created
  before keeps working on IPv4 until its owner downloads the configuration
  or scans the QR code again. See docs/wireguard-setup.md.
## 0.1.0-alpha.20 — 2026-11-10

- **Change your own password.** A signed-in user had no place to change
  their password; only the forced change at first login and the reset link
  existed. There is now a **Change password** link under your name in the
  staff sidebar and in the header of the reseller, collector and carrier
  apps. It asks for the current password and the new one, then signs you out
  everywhere so you sign in again.
- **Stripe calls name their API version.** Every Stripe request now sends a
  fixed `Stripe-Version`, so a new Stripe account or a dashboard upgrade
  cannot change how the integration behaves. `STRIPE_API_VERSION` overrides
  it.
- **A Stripe payment is recorded with the method really used.** With cards
  and OXXO both offered at checkout, an OXXO payment used to be saved as a
  card payment, which put the wrong SAT forma de pago on the payment receipt
  (REP). The method is now read from the Stripe charge: credit card, debit
  card, OXXO or bank transfer.
- **The Helm chart is published to GitHub Container Registry.** Each version
  now has one tag and one GitHub release (`vX.Y.Z`). Before, the chart
  publisher also made a `vigabss-X.Y.Z` tag and release that held only the
  chart file. Install or upgrade with
  `helm install vigabss oci://ghcr.io/vothalvino/charts/vigabss --version X.Y.Z`
  (no `helm repo add`). The chart is signed with cosign like the image.

## 0.1.0-alpha.19 — 2026-11-09

- **Each reseller and collector has its own page.** The Resellers page
  used to put a "choose a reseller" drop-down on every tab, and forgot
  the choice when you switched tabs. It is now a list you can search (name,
  contact, city, email or phone) and filter by type and status. Each row
  shows the point's cash on hand against its limit and what it earns.
  Opening one shows its page, with a header that has its type, status,
  cash, and Edit, Suspend and Delete buttons. Its tabs work on that point
  with no picker: Summary (contact details, its numbers and its
  sub-resellers), Movements, Bags, Commissions, Statements, Allowed plans
  and Staff access. A collector has no Commissions or Allowed plans. A
  sub-reseller shows Summary and Staff access, with a link to the
  reseller whose account it uses. The open tab is kept in the address,
  so a link or a refresh returns to it.
- **Bags can be assigned straight to a reseller or collector.** A point's
  Bags tab and the Cash bags board have an "Assign bags" form. You can
  deliver the bags yourself (or the point picks them up at the office),
  which needs no carrier. Or you can send them with a carrier, and only the
  carriers that serve that point are offered. Before, bags could only be
  handed to a carrier, and the form was only on the Cash bags page. Returning
  a bag assigned with no carrier puts it back in stock.

## 0.1.0-alpha.18 — 2026-11-09

- **WireGuard tunnels connect and reach the internet.** The hub's firewall
  named ICMPv6 by a name the server image cannot look up, so the whole
  firewall was rejected: full-tunnel traffic had no route or address
  translation to the internet. Creating a tunnel also stopped at that error,
  so the new device was never added to the hub and could not connect. The
  firewall now installs, and a firewall problem no longer keeps a new tunnel
  off the hub. Full-tunnel configurations also name public DNS servers
  (`WG_CLIENT_DNS`, default 1.1.1.1 and 9.9.9.9), because the phone's own
  resolver is often on a private address the hub does not forward to.
  Download the configuration or QR code again after upgrading to get the DNS
  line.

## 0.1.0-alpha.17 — 2026-11-09

- **A WireGuard tunnel is only issued when it can work.** With the
  WireGuard hub turned off (Settings → WireGuard), the server's key is never
  loaded, but tunnels could still be created: their configuration had an
  empty server key, which phones reject when scanning the QR code ("invalid
  peer"), and they could not connect anyway. Creating a tunnel, rotating its
  keys and downloading its configuration or QR code are now refused while
  the hub is off or not ready, with the reason, and the tunnels page shows a
  warning and disables "Add tunnel". Tunnels created earlier work as soon as
  the hub is turned on: download the configuration or QR code again.
- **The password policy can be edited from Security & Access Control.** The
  page only showed five of its values, with no way to change them. It is now
  a form for all of them: minimum length, required uppercase, lowercase,
  numbers and symbols, repeated characters, how many old passwords cannot be
  reused, how often a new one is required, and how many wrong passwords lock
  a staff account and for how long. The API also refused nothing when a
  whole number was expected there (it took text or 9.5); it now answers
  "must be a whole number".
- **API token rate limits can be edited too.** The API tab only listed them.
  You can now add a limit for a token (picked by name), change it or turn it
  off: a burst per second and limits per minute, hour and day, with the
  defaults shown for empty fields.
- **Security & Access Control only shows what works.** The Network Security
  and Data Security tabs and the passkey list are gone: firewall rules, DDoS
  rules, blackhole routes, DNS blocklists, CPE scans, encryption keys, data
  masking, the TLS text and the secure deletion log were saved and listed
  but nothing ever applied them (the daily retention purge never wrote to
  that log). Their stored data is kept. The page now has two tabs: User
  security (password policy, admin IP allowlist, blocked IPs) and API
  security (token rate limits).
- **Every sign-in is in the audit log, and repeat offenders are blocked.**
  Staff and customer-portal sign-ins, good or bad, now appear in the audit
  log with their own action (for example "Staff sign-in failed", "Staff
  account locked", "Portal sign-in"), the IP and the browser, so you can
  filter them. Staff sessions keep the IP they signed in from. An IP with 20
  failed sign-ins within an hour is blocked from every sign-in page for 24
  hours; if it comes back, for 7 days, then 30. Office, private and server
  addresses are never blocked. The install operator can see the blocked
  IPs, block one by hand or lift a block under Security & Access Control →
  User security. The limits are set with `LOGIN_IP_BLOCK_*` in the
  environment.
- **The audit log's action filter lists every action.** It used to offer
  only a few fixed actions, so most entries (cash bags, CFDI, reseller
  statements and more) could not be picked and showed as a grey code. The
  filter now lists the actions that actually occur, grouped by category
  (Sign-in, Billing and SAT, Cash bags...), with readable names, and you
  can pick a whole category. The IP column shows the address where one
  was recorded.
- Migration 013 adds the blocked-IP list, its two permissions (admin) and
  an index for the audit log's action filter.
- **Customers can pay ahead, and their credit pays the next invoices.** A
  reseller or collector can take a payment from a customer who owes nothing,
  or more than what is owed: the extra is the customer's credit, shown on the
  receipt ("Saldo a favor"). Customers can also pay ahead online from the
  portal ("Pagar por adelantado" on the Payments page). Credit is now used
  on its own: when an invoice is created it is paid from the customer's
  credit right away (before it is stamped, so it is stamped as paid), and a
  daily check applies it before anyone is suspended. When staff create an
  invoice by hand, "Use the customer's credit" is ticked; untick it to keep
  the credit for later.
- Migration 012 adds the invoice's "use credit" setting.
- **Mi caja is simpler.** It opens with one figure, what the point must hand
  in to the company (or what the company owes it), the cash already in
  bags, and how far it is from its limit, with a button to fill a bag when
  it gets there. Below, three tabs: **Hoy** (today's payments; tap one for
  its receipt or to void it), **Movimientos** (every line of its account,
  grouped by day: + adds to what it owes, − lowers it) and **Estados de
  cuenta**. The daily "Cerrar caja" (counting the drawer) is gone from the
  reseller app, and so is the second "should have" total that read like
  the amount owed. In English the page is now "My cash".
- **A change to the proxy's settings now takes effect on update.** The
  bundled nginx kept running with the settings file it started with, so an
  update that changed them (such as the signing-link masking in alpha.16)
  did not reach it until the server restarted. `sudo redeploy` now notices a
  changed file, checks it, and restarts nginx; if the new file fails the
  check, nginx keeps running as it was and the update says so. On an
  install that uses the server's own nginx (host-nginx), copy the new
  `nginx/host-nginx.conf` into `/etc/nginx/conf.d/` by hand, as before.

## 0.1.0-alpha.16 — 2026-11-08

- **Signing links stay out of the logs.** The token of a remote signing link
  is what lets the customer sign, and the app's request log and the proxy's
  access log were recording it in full. Both now mask it (in the address and
  in the referer), and the signing page tells the browser not to send its
  address to anything it loads. Links sent before this update keep working
  until they expire; to be safe, revoke any live ones and send new ones.
- In the reseller app, listing the faults of a client outside the reseller's
  customers is now refused (404) like every other client lookup, instead of
  returning an empty list.
- **Manager.** A new built-in user group for whoever runs the operation: it
  can do everything an administrator does except change the organization's
  settings, create or edit staff users and their groups, and touch security
  and integrations (API tokens, webhooks, PAC, certificates, payment
  gateways). It can create reseller and carrier logins.
- **Cash bags go to a point when they leave the office.** Staff (admin,
  manager or super admin) now choose, when they hand bags to a carrier, the
  point they are for. The bags appear on that reseller's page right away
  ("En camino") and it can fill them as soon as it has them; the carrier
  only carries them, and its "Entregar" just confirms the delivery at that
  point. A bag for another point is refused.
- **The cash limit means "fill a bag", not "stop".** A reseller (or
  collector) is no longer refused the payment that takes it past its cash
  limit: the payment goes through in full. Once its cash reaches the limit,
  it has to fill a bag (or hand the cash in) before it can take the next
  one. The app says how much is left before the limit instead of "you can
  still collect".
- Migration 010 adds the Manager group and the point login permission.
- **Collectors ("Cobrador").** A new kind of point that only takes
  payments, like a corner store: created on the resellers page as "Tipo:
  Cobrador", with its own cash limit, cash box, bags and monthly statements.
  It cannot see the ISP's customers, their counts or prospects, and finds a
  customer only by the customer number. For each payment it keeps a fee set
  per collector, a fixed amount or a percentage; a voided payment gives the
  fee back. Its app has Inicio (its cash and fees), Cobrar, Mi caja and
  Bolsas. A reseller with no customers, prospects or sub-resellers can be
  turned into a collector.
- Migration 011 adds collectors, their fees and the collector user group.

## 0.1.0-alpha.15 — 2026-11-08

- **Reseller program, phase 5: statements (estados de cuenta).** Staff close
  a month (or any past period) of a reseller's cash in a statement, in the new
  "Estados de cuenta" tab of the reseller page: what it owed at the start,
  what it collected, voided, sealed in bags, kept as commission, handed in or
  was paid in the period, and what it owes at the end ("Debes entregar"), or
  what the ISP owes it ("Te debemos"). The figures always come from its
  movements, never typed in.
  - **Commissions are checked first.** Before a statement is drawn up, every
    paid invoice of the reseller's customers is checked against its
    commissions: a missing one is booked and one whose invoice is no longer
    paid is reversed. This also repairs the rare voided or SAT-cancelled
    invoice whose commission could not be reversed at the time. Staff can run
    the check on its own too.
  - **Draft, approved, settled.** A draft can be redone or discarded. Once
    approved it never changes: a movement posted later, such as a late
    reversal, goes in the next statement. Approving needs its own permission,
    so one person can prepare a statement and another approve it.
  - **Settling** records the transfer that squares the statement, with its
    bank reference: what the reseller handed in, or what the ISP paid it. If
    that money already moved some other way (in cash bags, for example), it
    can be marked settled without recording it again.
  - **PDF.** Staff and the reseller download each statement as a PDF. The
    reseller sees its approved and settled statements in Mi caja.
- Migration 008 adds the statements and their permissions.
- **Reportar falla.** In the reseller app, a client's page has a "Reportar
  falla" button: the reseller describes the problem and it becomes a ticket in
  the ISP's queue, marked as reported by that reseller. Staff are notified as
  for any new ticket; the customer is not. The reseller sees the status of
  what it reported.
- **The customer signs on its own phone.** Staff can send the customer of an
  installation in process a link (by email or SMS to the contact on file, or
  copy it to hand over) to read and sign the installation documents from its
  own phone. A reseller can ask the ISP to send it for its own customer, but
  never sees the link. The usual rules still apply: the installation
  authorization can be signed right away, the contract only once the
  technician's visit has started. The signature is recorded as the
  customer's own, with the link it came through. Links expire after 72 hours
  (`SIGNING_LINK_TTL_HOURS`) and a new one replaces the old.
- Migration 009 adds the signing links and the ticket's reseller.

## 0.1.0-alpha.14 — 2026-11-07

- **Reseller program, phase 4: resellers earn their commission.** When an
  invoice of a customer a *Punto de Venta* brought in is paid, the reseller
  earns its commission percentage of the invoice amount before IVA, whoever
  took the money: the reseller itself, the ISP's staff, an online payment or
  another reseller.
  - **The reseller keeps it from the cash it holds.** A "Comisión" line in
    its movements lowers what it owes the ISP ("Debes entregar") at once. If
    the invoice stops being paid (the payment is deleted, unapplied, moved or
    refunded, the collection is voided, a credit note is cancelled, or the
    invoice is voided, cancelled at SAT or deleted), a reversal line puts it
    back; paying the invoice again earns it again, never twice.
  - **Sub-resellers:** their customers earn the commission of the top-level
    reseller, at its rate and on its account.
  - **Only new payments count:** invoices paid before you upgrade (or, for
    an organization created later, before it was created) earn nothing, nor
    do imported invoices marked paid; there is no back-pay. An invoice's
    payment date can no longer be edited by hand.
  - **What does not earn:** an invoice in another currency than the
    organization's. An invoice settled by a credit note counts as paid and
    earns like any other.
  - **When the ISP owes the reseller** (its commissions are more than the
    cash it holds, "Te debemos"), staff record what they pay it as a payout
    in its movements, at most what is owed.
  - Staff see each commission (invoice, amount before IVA, rate, amount,
    earned or reversed) in the reseller's Commissions tab; the old approve
    step is gone. The reseller app shows the commission of the month, and
    "Te debemos" instead of "Debes entregar" when the ISP owes the reseller.
- **Fixes found on the way:** restoring a deleted payment can no longer mark
  a voided or cancelled invoice as paid; unapplying or moving a payment now
  updates the invoice's paid status in the same step; the reseller dashboard
  counts revenue by the day invoices were paid.
- Migration 007 adds the commission fields and the new movement types, and
  records the upgrade time as the start of commissions.

## 0.1.0-alpha.13 — 2026-11-07

- **Sealing a cash bag now takes the money off the reseller's account at
  once.** When a *Punto de Venta* seals a bag, the declared amount is
  removed from what it owes the ISP right away, with a "Bolsa sellada" line
  in its movements. The bag's cash is then shown apart, as waiting for the
  carrier or on its way, and no longer counts as the reseller's.
  - **Receiving a bag** only records a difference: if the counted cash
    matches what was declared nothing more is posted; a short bag raises
    what the reseller owes and an over bag lowers it.
  - **A lost bag is the ISP's loss.** Marking a sealed bag lost posts
    nothing, so the reseller does not owe the declared amount again.
  - Staff cannot record a "Bolsa sellada" line by hand.
- **Reseller drop-downs list every reseller.** The reseller pickers and
  filters in Resellers, Leads and Cash bags used to show only the first 100;
  they now load them all (up to 5,000, with a notice when there are more).
- Migration 006 adds the new ledger line and posts it for the bags that
  were already sealed or on their way when you upgrade.

## 0.1.0-alpha.12 — 2026-11-07

- **Reseller program, phase 3: cash bags and carriers.** Collected cash now
  travels from a *Punto de Venta* to the ISP in numbered bags.
  - **Bags:** staff register bags by serial, one at a time or as a range,
    and hand a batch to a carrier. Each bag moves through in stock, with a
    carrier, at a reseller, ready for pickup, on its way and received. Void
    and lost are also possible, and every step is recorded with who did it
    and when.
  - **Reseller (`/punto/bolsas`):** the reseller fills a bag, declares the
    amount and seals it. That cash leaves cash on hand, so the credit limit
    frees right away; the debt still counts it until the ISP receives the
    bag. When the limit is reached, Cobrar says to fill a bag. Received bags
    disappear from the reseller app.
  - **Carrier app (`/ruta`):** a new `carrier` login, made for phones, that
    sees only the resellers assigned to it. It drops off empty bags and
    picks up sealed ones, scanning the serial with the camera or typing it;
    the serial must match. A carrier never sees amounts, customers or other
    resellers, and its login can't open any other part of the system.
  - **Staff (`Bolsas de efectivo`):** a board of bags ready for pickup, on
    their way, received and with differences, plus a Carriers tab to create
    carrier logins and choose their resellers. On receipt staff enter the
    counted amount: the declared amount is booked as handed in, and any
    shortfall or overage is posted to the reseller as an adjustment. Each
    reseller also gets a Bolsas tab.
  - **Resellers** gain an address, city and map location, which their
    carriers see.
  - **Permissions:** `carrier_app.use`, `carrier_app.pickup`,
    `cash_bags.view`, `cash_bags.manage`, `cash_bags.receive`,
    `carriers.manage` and `reseller_app.bags`. Creating a carrier login also
    needs `users.create`.
  - **Mi caja** now shows whether the box is open or closed.
  - Migration 005 adds the bag, bag event and carrier assignment tables.

## 0.1.0-alpha.11 — 2026-11-07

- **Reseller app, phase 2: resellers collect cash.** A *Punto de Venta* can
  now take cash payments, up to a credit limit: the most collected cash it
  may hold before handing it in to the ISP.
  - **Cobrar:** the reseller's own customers, or any subscriber found by
    exact customer number or phone. A customer that isn't the reseller's own
    shows only a masked name. The payment pays the oldest invoices first,
    reconnects a suspended service and issues the payment complement (REP).
  - **Receipt:** printable on 58 or 80 mm paper, or shared by WhatsApp. It
    says the reseller collected on the ISP's behalf.
  - **Mi caja:** today's collections, a same-day void by the user who
    collected, and closing the cash box with the counted amount.
  - **Credit limit:** a default for every reseller in the organization
    settings (2000.00), which each reseller's form can override. Over the limit, the
    collection is refused and the app says how much can still be collected.
  - **Cash ledger:** what each reseller owes the ISP. Staff record the cash
    it hands in, and adjustments, in the reseller's new **Movimientos** tab.
    A sub-reseller's cash is booked on its top-level reseller.
  - **Payments** shows the reseller that collected a payment and can be
    filtered by it.
  - Restoring a deleted payment is now refused unless it was completed, and
    always for a collection a reseller voided.
  - The `/punto` header no longer cuts off the reseller's name.
  - Migration 004 adds the credit limit, the collecting reseller on payments
    and the cash ledger. Its rollback refuses to run once collections exist.

## 0.1.0-alpha.10 — 2026-11-07

- **Reseller accounts can manage their own passkeys again.** The reseller
  fence (0.1.0-alpha.9) blocked `/security-admin/webauthn`, although the
  reseller role keeps `webauthn.*`. It now allows exactly that path, which
  lists and revokes only the caller's own credentials. The rest of security
  admin stays blocked.

## 0.1.0-alpha.9 — 2026-11-07

- **Reseller app, phase 1: resellers can sign up customers.** A reseller is
  now a *Punto de Venta*: a commission agent who signs up neighbours, while
  the ISP converts, signs the contract and installs. A user bound to a
  reseller lands on **`/punto`**, a phone-first app in Spanish, English and
  Portuguese with four screens:
  - **Inicio:** counts of active, suspended and overdue clients, and open
    leads.
  - **Clientes:** the reseller's own customers, with balances and invoices.
  - **Nuevo cliente:** captures a lead with the plan, the tax details and the
    phone's location, and shows a coverage summary.
  - **Prospectos:** the reseller's leads.

  Leads appear in the ISP's lead inbox tagged with the reseller. Once a lead
  is converted, the customer shows in the reseller's list.
- **Admin:**
  - New and edit forms for resellers.
  - An **Allowed plans** tab; if no plans are selected, every active plan is
    allowed.
  - **Create login**, which creates a reseller user and binds it in one step.
  - The lead list shows the reseller and can be filtered by it.
  - Half-built tabs are hidden: plan prices, resources, billing entity,
    branding, and per-row commission approval.
- **Security:**
  - A reseller-bound account can only reach the reseller app, sign-in,
    two-factor and notifications. Every other API returns 403, whatever its
    permissions, and the staff WebSocket refuses it.
  - Bound users can no longer change commission, status or other ISP-owned
    reseller settings.
  - The reseller portal no longer returns full client and invoice rows
    (password and reset hashes, CURP, notes).
  - The coverage summary does not reveal network devices or coordinates.
- **Removed:** the reseller portal's suspend, cancel and create-client
  endpoints. They only changed a status field and left the subscriber online.
- **Migration 003:**
  - Adds `leads.reseller_id` and the `reseller_allowed_plans` table.
  - Grants `reseller_app.use` and `reseller_app.signup` to reseller_admin,
    and removes its reseller administration view grants.

## 0.1.0-alpha.8 — 2026-11-06

- **Signed copies are named after the contract and the signing date.** A
  downloaded activation contract is now `contrato-<contract>-<YYYY-MM-DD>.pdf`
  (`contract-…` outside Mexico) instead of `document-<id>.pdf`. The date is
  the signing day in Mexico City time for MX organizations, UTC otherwise.
  Other documents on the same contract are prefixed with their kind (for
  example `acuse-servicio-contrato-…`), so they do not share a name. A
  document without a contract uses its own number. Staff and portal
  downloads both use the server's name.

## 0.1.0-alpha.7 — 2026-11-06

- **Signed contracts stay reachable after activation.** The signed-document
  View and Download were only on the activation card, which disappears once a
  contract is active. The contract page now has a **Signed documents** tab at
  every status, and the customer's **Documents** tab lists the signed
  contracts and documents across all of their contracts, each with View and
  Download PDF. Both need the `signed_documents.view` permission.

## 0.1.0-alpha.6 — 2026-11-06

- **Signed documents can be read and downloaded again.** Once signed, an
  activation contract (or service acknowledgment, or installation
  authorization) only showed "Signed by <name>". Staff now open it from the
  contract or work order (**View**: the text exactly as signed, the signature,
  signer, date, signing IP, environment, registered contract and whether the
  stored evidence still verifies) and download a PDF copy. Subscribers get a
  **Documents** page in the portal with their own signed documents and a PDF
  copy of each (`GET /portal/documents`, `/portal/documents/{id}`,
  `/portal/documents/{id}/pdf`; staff: `GET /signed-documents/{id}/pdf`).

## 0.1.0-alpha.5 — 2026-11-06

- **Contract activation is a guided page.** A step tracker (schedule visit,
  test connection, customer signs, finish visit, activate) and one "Next:"
  sentence lead the card; only the current step shows its controls, finished
  steps fold into a summary, and locked steps say what unlocks them. While the
  test line is switching off it says when the visit can be finished and why,
  instead of claiming temporary internet is still on and offering the speed
  test again (#108).
- **The Helm chart is named `vigabss`.** It carried a different name, so every
  release published a chart release under that name. The chart now lives in
  `charts/vigabss`; the docs install it as `helm install vigabss vigabss/vigabss`
  into the `vigabss` namespace, with `vigabss` database defaults.
- **Prometheus alerts can fire.** The alert rules selected a different job name
  while the docs configure the scrape job as `vigabss`, so no rule matched any
  series; both rule files now select `vigabss`, and a test keeps them aligned.
- **The Resellers page shows write actions only to users who may use them.**
  A reseller user saw Suspend, Delete, Approve and Remove buttons on the
  reseller list, plan price, commission and IP pool tabs that could only answer
  403; each now requires the permission its route checks (#106).

## 0.1.0-alpha.4 — 2026-11-06

Fixes from testing the customer and reseller portals on a live install.

- **Security: reseller users no longer see or change ISP-wide security
  settings.** Migration 002 (the first after the baseline) removes nine
  permissions the `reseller_admin` group had held since before reseller
  scoping existed, including adding admin IP allowlist entries — enough to
  lock the ISP's administrators out of admin pages. Reseller users keep their
  reseller-scoped access and their own passkeys.
- **Pages load after an update.** A tab opened before a deploy asked for the
  old page files and got the app's HTML back (cached for a year), so pages
  such as Payments did not load. Missing files are now a plain 404, and the
  app reloads once into the new version.
- **Users without operations access land on a page they can use.** A reseller
  user opened on the Operations Overview, every tile refused; they now start
  on Resellers.
- **CI runs the full unit test suites on pull requests**, not only after merge.

## 0.1.0-alpha.3 — 2026-11-06

Fixes found by testing 0.1.0-alpha.2 on a live install.

- **Suspending a contract no longer reports success when nothing happened.**
  A pending contract, or a suspension-exempt client, now gets a 422 that says
  why, instead of `status: suspended` while the subscriber stays online.
- **The update banner follows the install's channel.** A release-channel
  install (the default) compares against the newest `v*` release, not the
  head of `main`, so a merge no longer shows a phantom update.
  `VIGABSS_CHANNEL` now reaches the app container.
- **New clients take their organization's locale.** In an MX organization,
  clients created from the API, the form, the reseller portal or CSV import
  are MX unless another locale is chosen, so they get the MX rules
  (border-region IVA, CFDI).
- **The API spec lists only endpoints that exist.** 21 documented operations
  were not served; a test now walks the router and fails on any such entry.

## 0.1.0-alpha.2 — 2026-11-06

Fixes found on the first real install of 0.1.0-alpha.1. Install this release
instead; alpha.1 cannot complete a fresh install.

- **Fresh installs no longer stop before migrating.** The pre-migration backup
  looked up isolated tenants on an empty database (`ER_NO_SUCH_TABLE`).
- **The SNMP trap listener starts, and `/health/ready` passes.** Its schema
  check looked for migration 459, which is part of the release baseline now.
- **`redeploy <tag>` rollbacks work again.** The guard checked for the 459/460
  migration files; it now requires a release that contains the baseline.
- **Helm chart releases publish without manual help** (chart-releaser now has
  a git identity).

## 0.1.0-alpha.1 — 2026-11-05

The first tagged release, and the first one installs follow by default
(`VIGABSS_CHANNEL=release`). It is an **alpha**: everything below is built and
covered by automated tests, but most items on
[the pre-launch checklist](docs/pre-launch-test-checklist.md) have not yet run
against real hardware or providers — PAC stamping, Stripe/Conekta payments and
refunds, and RADIUS accounting from a real NAS among them. Treat it as ready
for a pilot, not for production billing.

### Installing

- Fresh installs only: `install.sh` (Docker Compose) or the Helm chart
  (`charts/vigabss`). The release image is
  `ghcr.io/vothalvino/vigabss:0.1.0-alpha.1`, multi-arch (amd64 and arm64)
  and signed with Cosign; `redeploy` verifies the signature.
- The database is built from one migration, `001_baseline.sql`: the 525
  development migrations were squashed into it, after CI proved it produces an
  identical database on MySQL 8.4 and MariaDB 10.6. A database created from the
  development history is refused with an explanation; recreate it.

### Notable changes since development began

- **Security and tenancy.** Every API route requires sign-in unless reviewed as
  public, a real-database sweep checks every route against cross-organization
  access as both a Mexican and a global organization, and every write route
  answers bad input with a 4xx. The API is served only under `/api/v1`.
- **Collectors.** FreeRADIUS accounting and PPPoE events authenticate with
  single-scope organization API tokens only; accounting runs on its own
  database pool and is counted on `/metrics`.
- **Billing and Mexico.** Factura global, late fees on the unpaid share,
  provider refunds that flag a live REP, frozen cash-reconciliation sessions,
  CFDI sandbox/production environments, and IPv6 in the legal IP-attribution
  lookup and government requests.
- **Operations.** Background CSV imports, a payment problems page, queue and
  RADIUS monitoring, firmware installs confirmed by the CPE, the container
  running as uid 10001, opt-in egress network policy, and a blocking DAST scan.
- **Fixes found by the pre-release cleanup.** Four tables declared no
  collation; 17 shipped SNMP profiles could be claimed by one tenant; on
  MariaDB, editing a speed test rewrote when it was measured.
- Scheduled-task locks use their own connection pool, so a burst of due tasks
  can no longer deadlock the API (#51). Database pools fail fast with
  `503 DB_POOL_EXHAUSTED` instead of hanging, and report their usage on
  `/metrics`. Billing, payment gateway and PAC failures are counted and
  alerted.
