// Hand-labelled evaluation set (v1). Labels were written on 2026-11-02 BEFORE any run, from
// the labeller's knowledge (Claude, knowledge to ~mid 2026) and are fixed for the run.
// label: "stale" = no longer true today (superseded or never true); "current" = true today.
// confidence "medium" marks items where a change after mid-2026 is possible; discrepancies on
// those are investigated from the evidence, never silently relabelled.
//
// Categories mirror the claim classes Halflife has to handle. Static facts measure that triage
// does not spend credits on them.

export const SET_VERSION = "v1-2026-11-02";

export const ITEMS = [
  // ---- leadership
  { id: "lead-01", cat: "leadership", text: "Jack Dorsey is the CEO of Twitter.", label: "stale", conf: "high", truth: "Dorsey left in Nov 2021; Musk 2022, Yaccarino 2023–Jul 2025." },
  { id: "lead-02", cat: "leadership", text: "Pat Gelsinger is the CEO of Intel.", label: "stale", conf: "high", truth: "Gelsinger retired Dec 2024; Lip-Bu Tan CEO since Mar 2025." },
  { id: "lead-03", cat: "leadership", text: "Laxman Narasimhan is the CEO of Starbucks.", label: "stale", conf: "high", truth: "Brian Niccol since Sep 2024." },
  { id: "lead-04", cat: "leadership", text: "Susan Wojcicki is the CEO of YouTube.", label: "stale", conf: "high", truth: "Neal Mohan since Feb 2023." },
  { id: "lead-05", cat: "leadership", text: "Satya Nadella is the CEO of Microsoft.", label: "current", conf: "high", truth: "CEO since 2014." },
  { id: "lead-06", cat: "leadership", text: "Jensen Huang is the CEO of Nvidia.", label: "current", conf: "high", truth: "Co-founder, CEO since 1993." },
  { id: "lead-07", cat: "leadership", text: "Andy Jassy is the CEO of Amazon.", label: "current", conf: "high", truth: "CEO since Jul 2021." },
  { id: "lead-08", cat: "leadership", text: "Linda Yaccarino is the CEO of X, formerly Twitter.", label: "stale", conf: "high", truth: "Resigned Jul 2025." },
  { id: "lead-09", cat: "leadership", text: "Sundar Pichai is the CEO of Alphabet.", label: "current", conf: "high", truth: "CEO of Alphabet since Dec 2019." },
  // ---- office holders (politics)
  { id: "office-01", cat: "office", text: "Joe Biden is the President of the United States.", label: "stale", conf: "high", truth: "Donald Trump inaugurated Jan 20, 2025." },
  { id: "office-02", cat: "office", text: "Rishi Sunak is the Prime Minister of the United Kingdom.", label: "stale", conf: "high", truth: "Keir Starmer since Jul 2024." },
  { id: "office-03", cat: "office", text: "Olaf Scholz is the Chancellor of Germany.", label: "stale", conf: "high", truth: "Friedrich Merz since May 2025." },
  { id: "office-04", cat: "office", text: "Justin Trudeau is the Prime Minister of Canada.", label: "stale", conf: "high", truth: "Mark Carney since Mar 2025." },
  { id: "office-05", cat: "office", text: "Pope Francis is the current Pope.", label: "stale", conf: "high", truth: "Francis died Apr 2025; Leo XIV elected May 2025." },
  { id: "office-06", cat: "office", text: "António Guterres is the Secretary-General of the United Nations.", label: "current", conf: "medium", truth: "Second term runs to 31 Dec 2026; successor selection during 2026." },
  { id: "office-07", cat: "office", text: "Mark Rutte is the Secretary General of NATO.", label: "current", conf: "high", truth: "Since Oct 2024." },
  { id: "office-08", cat: "office", text: "Fumio Kishida is the Prime Minister of Japan.", label: "stale", conf: "high", truth: "Ishiba Oct 2024, then Takaichi Oct 2025." },
  // ---- software / API versions
  { id: "ver-01", cat: "version", text: "The latest stable version of Python is 3.11.", label: "stale", conf: "high", truth: "3.12 (2023), 3.13 (2024), 3.14 (2025), 3.15 (Oct 2026)." },
  { id: "ver-02", cat: "version", text: "The latest major version of React is React 19.", label: "current", conf: "medium", truth: "React 19 (Dec 2024); 19.x through 2026 per live run 1." },
  { id: "ver-03", cat: "version", text: "The current Node.js LTS release line is Node.js 18.", label: "stale", conf: "high", truth: "Node 18 reached end-of-life Apr 2025." },
  { id: "ver-04", cat: "version", text: "The latest version of Apple's iPhone operating system is iOS 17.", label: "stale", conf: "high", truth: "iOS 18 (2024), iOS 26 (2025)." },
  { id: "ver-05", cat: "version", text: "The newest iPhone model is the iPhone 15.", label: "stale", conf: "high", truth: "iPhone 16 (2024), iPhone 17 (2025)." },
  { id: "ver-06", cat: "version", text: "The latest stable release of the Linux kernel is version 6.1.", label: "stale", conf: "high", truth: "6.1 was Dec 2022; kernels release every ~9–10 weeks." },
  // ---- prices
  { id: "price-01", cat: "price", text: "ChatGPT Plus costs $20 per month.", label: "current", conf: "medium", truth: "$20/month since launch (Feb 2023), confirmed live run 1." },
  { id: "price-02", cat: "price", text: "The Netflix Standard plan costs $15.49 per month in the US.", label: "stale", conf: "high", truth: "Raised to $17.99 in Jan 2025." },
  { id: "price-03", cat: "price", text: "YouTube Premium's individual plan costs $11.99 per month in the US.", label: "stale", conf: "high", truth: "$13.99 from Jul 2023; $15.99 from Apr 2026 (live run 1)." },
  { id: "price-04", cat: "price", text: "Spotify Premium Individual costs $9.99 per month in the US.", label: "stale", conf: "high", truth: "$10.99 (2023), $11.99 (2024)." },
  { id: "price-05", cat: "price", text: "The US federal minimum wage is $7.25 per hour.", label: "current", conf: "high", truth: "Unchanged since 2009." },
  // ---- rates / indicators
  { id: "rate-01", cat: "rate", text: "The US Federal Reserve's target range for the federal funds rate is 5.25% to 5.50%.", label: "stale", conf: "high", truth: "Cuts began Sep 2024." },
  { id: "rate-02", cat: "rate", text: "The European Central Bank's deposit facility rate is 4%.", label: "stale", conf: "high", truth: "Cut from Jun 2024; 2% by mid-2025." },
  { id: "rate-03", cat: "rate", text: "India is the most populous country in the world.", label: "current", conf: "high", truth: "Overtook China in 2023 (UN)." },
  // ---- sport / records
  { id: "sport-01", cat: "sport", text: "Lionel Messi plays for Paris Saint-Germain.", label: "stale", conf: "high", truth: "Inter Miami since Jul 2023." },
  { id: "sport-02", cat: "sport", text: "Magnus Carlsen is the reigning World Chess Champion.", label: "stale", conf: "high", truth: "Ding Liren 2023, Gukesh Dec 2024." },
  { id: "sport-03", cat: "sport", text: "The Burj Khalifa is the tallest building in the world.", label: "current", conf: "high", truth: "828 m; Jeddah Tower not complete." },
  // ---- membership / status
  { id: "status-01", cat: "status", text: "The United Kingdom is a member of the European Union.", label: "stale", conf: "high", truth: "Left 31 Jan 2020." },
  { id: "status-02", cat: "status", text: "Sweden is not a member of NATO.", label: "stale", conf: "high", truth: "Joined Mar 2024." },
  // ---- static facts (must be triaged static: no credits)
  { id: "static-01", cat: "static", text: "The Battle of Hastings was fought in 1066.", label: "current", conf: "high", truth: "Historical fact." },
  { id: "static-02", cat: "static", text: "Water boils at 100 degrees Celsius at sea level.", label: "current", conf: "high", truth: "Physical constant (standard pressure)." },
  { id: "static-03", cat: "static", text: "The chemical symbol for gold is Au.", label: "current", conf: "high", truth: "Definition." },
  { id: "static-04", cat: "static", text: "The speed of light in a vacuum is 299,792,458 metres per second.", label: "current", conf: "high", truth: "Defined constant." },
];

// ---- v2 (written 2026-11-02 after v1 saturated at 40/40): harder cases, labels fixed before
// the run. "ambiguous" = sources genuinely disagree or the claim depends on a definition; any
// verdict is scored separately (abstaining or flagging conflict is the desirable behaviour).
export const SET_V2 = "v2-2026-11-02";
export const ITEMS_V2 = [
  // subtly wrong values: contradicted, not superseded
  { id: "v2-wrong-01", cat: "wrong-value", text: "The Burj Khalifa is 900 metres tall.", label: "stale", conf: "high", truth: "828 m." },
  { id: "v2-wrong-02", cat: "wrong-value", text: "Python 3.12 was released in October 2022.", label: "stale", conf: "high", truth: "Released 2 Oct 2023 (3.11 was Oct 2022)." },
  { id: "v2-wrong-03", cat: "wrong-value", text: "Satya Nadella became CEO of Microsoft in 2016.", label: "stale", conf: "high", truth: "February 2014." },
  { id: "v2-wrong-04", cat: "wrong-value", text: "ChatGPT Plus costs $25 per month.", label: "stale", conf: "medium", truth: "$20/month (live runs)." },
  // recent changes that ARE current (a stale-biased judge would get these wrong)
  { id: "v2-recent-01", cat: "recent-current", text: "Lip-Bu Tan is the CEO of Intel.", label: "current", conf: "high", truth: "Since Mar 2025; live run 1." },
  { id: "v2-recent-02", cat: "recent-current", text: "Friedrich Merz is the Chancellor of Germany.", label: "current", conf: "medium", truth: "Since May 2025." },
  { id: "v2-recent-03", cat: "recent-current", text: "Neal Mohan is the CEO of YouTube.", label: "current", conf: "high", truth: "Since Feb 2023." },
  { id: "v2-recent-04", cat: "recent-current", text: "Pope Leo XIV is the current Pope.", label: "current", conf: "high", truth: "Elected May 2025." },
  { id: "v2-recent-05", cat: "recent-current", text: "Mark Carney is the Prime Minister of Canada.", label: "current", conf: "medium", truth: "Since Mar 2025." },
  // explicitly time-scoped claims: true at their stated date (historical scope)
  { id: "v2-scoped-01", cat: "time-scoped", text: "In 2023, Rishi Sunak was the Prime Minister of the United Kingdom.", label: "current", conf: "high", truth: "PM Oct 2022–Jul 2024: true for its stated date." },
  { id: "v2-scoped-02", cat: "time-scoped", text: "As of 2021, the latest stable version of Python was 3.10.", label: "current", conf: "high", truth: "3.10 released Oct 2021: true for its stated date." },
  { id: "v2-scoped-03", cat: "time-scoped", text: "In January 2024, the Federal Reserve's target range was 5.25% to 5.50%.", label: "current", conf: "high", truth: "Held at 5.25–5.50 from Jul 2023 to Sep 2024." },
  // genuinely disputed / definition-dependent
  { id: "v2-amb-01", cat: "ambiguous", text: "The Amazon is the longest river in the world.", label: "ambiguous", conf: "high", truth: "Nile vs Amazon length is disputed (measurement method)." },
  { id: "v2-amb-02", cat: "ambiguous", text: "Tokyo has a population of about 37 million people.", label: "ambiguous", conf: "high", truth: "Metro area ~37M (declining), city proper ~14M." },
  { id: "v2-amb-03", cat: "ambiguous", text: "Mount Everest is 8,848 metres tall.", label: "ambiguous", conf: "high", truth: "8,848 m (older survey) vs 8,848.86 m (2020 joint survey)." },
];
