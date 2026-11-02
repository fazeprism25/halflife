// Claim classes and their change-rate priors.
//
// Model (research/ARCHITECTURE_DECISIONS.md AD-09): changes to a claim of class c arrive as a
// Poisson process with rate λ_c (per year). λ_c is uncertain, with prior Gamma(shape α, rate β).
// We parameterise each prior by a "typical lifetime" L (years between changes) and a shape α
// (lower α = less certain): β = α·L, so E[λ] = 1/L.
//
// These priors are ASSUMPTIONS with stated rationale, not measurements. They are versioned, shown
// in the console, and updated by verification outcomes (grid posterior, freshness.ts). Numbers
// here never come from an LLM.

export type ClassDef = {
  id: string;
  label: string;
  /** Description given to the extraction model so it can pick a class. */
  describe: string;
  /** Typical years between changes (prior mean of 1/λ). */
  lifetimeYears: number;
  /** Gamma shape. 1 = very uncertain, 3 = fairly confident. */
  alpha: number;
  rationale: string;
  /** Evidence older than this cannot count as "recent" for the evidence-confidence rules. */
  evidenceRecencyDays: number;
  tavilyTopic: "general" | "news" | "finance";
  /** Classes that never need web verification. */
  static?: boolean;
};

const DAY = 1 / 365.25;

export const CLASSES: ClassDef[] = [
  {
    id: "market.price", label: "Market price",
    describe: "Price or rate of a tradable asset, currency, commodity or crypto token (e.g. 'Bitcoin trades at $60k', 'EUR/USD is 1.08').",
    lifetimeYears: 1 * DAY, alpha: 2, evidenceRecencyDays: 2, tavilyTopic: "finance",
    rationale: "Quoted prices move continuously; a one-day typical lifetime is generous for claims stated to the nearest round number.",
  },
  {
    id: "market.metric", label: "Market metric",
    describe: "Market capitalisation, valuation, market share, ranking by size or revenue of a company (e.g. 'Apple is the most valuable company').",
    lifetimeYears: 60 * DAY, alpha: 1.5, evidenceRecencyDays: 30, tavilyTopic: "finance",
    rationale: "Valuation rankings and market-share figures are re-reported quarterly and reorder within months.",
  },
  {
    id: "org.leadership", label: "Organisation leadership",
    describe: "Who holds a leadership role in a company or organisation: CEO, chair, founder-led status, head coach, director (e.g. 'Satya Nadella is CEO of Microsoft').",
    lifetimeYears: 7, alpha: 1.5, evidenceRecencyDays: 365, tavilyTopic: "news",
    rationale: "Wikidata CEO (P169) tenures: closed tenures average 8.5 y, censored MLE 24.5 y (biased by stale open statements; feasibility sprint). 7 y with low shape covers both.",
  },
  {
    id: "gov.office_holder", label: "Government office holder",
    describe: "Who holds a political or public office: head of state or government, minister, governor, mayor, central-bank chair (e.g. 'Rishi Sunak is the UK prime minister').",
    lifetimeYears: 4, alpha: 2, evidenceRecencyDays: 365, tavilyTopic: "news",
    rationale: "Typical electoral cycles are 4–5 years; early resignations and reshuffles shorten this.",
  },
  {
    id: "software.version", label: "Software version",
    describe: "Latest or current version/release of software, a model, an API, a framework or an OS, or a release date of an upcoming one (e.g. 'The latest Python is 3.12').",
    lifetimeYears: 120 * DAY, alpha: 2, evidenceRecencyDays: 90, tavilyTopic: "general",
    rationale: "Major projects ship minor releases every 1–6 months; 'latest version' claims rarely survive half a year.",
  },
  {
    id: "product.offering", label: "Product offering",
    describe: "Price, plan, feature, specification or availability of a commercial product or service (e.g. 'ChatGPT Plus costs $20/month', 'the iPhone 15 is the newest iPhone').",
    lifetimeYears: 1, alpha: 1.5, evidenceRecencyDays: 180, tavilyTopic: "general",
    rationale: "Product lines and pricing are typically revised annually.",
  },
  {
    id: "org.facts", label: "Organisation facts",
    describe: "Ownership, headquarters, headcount, name, acquisition or operating status of an organisation (e.g. 'Twitter is owned by Elon Musk', 'X has 7,500 employees').",
    lifetimeYears: 3, alpha: 1.5, evidenceRecencyDays: 365, tavilyTopic: "news",
    rationale: "Headcount and ownership change on multi-year horizons, with occasional abrupt events.",
  },
  {
    id: "stats.indicator", label: "Statistical indicator",
    describe: "Population, GDP, inflation, unemployment, survey or census figure, user counts (e.g. 'India's population is 1.4 billion', 'ChatGPT has 100M weekly users').",
    lifetimeYears: 1, alpha: 2, evidenceRecencyDays: 365, tavilyTopic: "general",
    rationale: "Official statistics are revised at least annually; many monthly.",
  },
  {
    id: "policy.rate", label: "Policy rate or regulation value",
    describe: "A rate or threshold set by an authority: central-bank interest rate, tax rate, minimum wage, tariff (e.g. 'The Fed funds rate is 5.25–5.5%').",
    lifetimeYears: 0.5, alpha: 2, evidenceRecencyDays: 120, tavilyTopic: "news",
    rationale: "Central banks meet 8 times a year; tax and wage thresholds change about annually.",
  },
  {
    id: "law.regulation", label: "Law or regulation",
    describe: "Whether a law, rule, ban or legal status is in force (e.g. 'The EU AI Act is not yet in force').",
    lifetimeYears: 3, alpha: 1.5, evidenceRecencyDays: 365, tavilyTopic: "news",
    rationale: "Legislative status changes on multi-year horizons, with scheduled entry-into-force dates.",
  },
  {
    id: "sports.standing", label: "Sports result or standing",
    describe: "Current champion, title holder, ranking or season standing in a sport (e.g. 'Manchester City are the Premier League champions').",
    lifetimeYears: 1, alpha: 2, evidenceRecencyDays: 180, tavilyTopic: "news",
    rationale: "Most titles are contested annually; rankings move weekly.",
  },
  {
    id: "record.superlative", label: "Record or superlative",
    describe: "A record or superlative: tallest, largest, fastest, best-selling, most-used (e.g. 'Burj Khalifa is the tallest building').",
    lifetimeYears: 5, alpha: 1.5, evidenceRecencyDays: 730, tavilyTopic: "general",
    rationale: "Records fall on multi-year horizons; tech superlatives faster.",
  },
  {
    id: "person.status", label: "Person status",
    describe: "A person's current role, employer, residence, age, marital status or whether they are alive (e.g. 'Jeff Bezos is the richest person').",
    lifetimeYears: 4, alpha: 1.5, evidenceRecencyDays: 365, tavilyTopic: "news",
    rationale: "Personal circumstances change on multi-year horizons.",
  },
  {
    id: "event.scheduled", label: "Scheduled or upcoming event",
    describe: "A future or upcoming event, plan or announcement stated as not yet happened (e.g. 'GPT-5 has not been released yet', 'the next Olympics will be in Paris').",
    lifetimeYears: 0.5, alpha: 1.5, evidenceRecencyDays: 120, tavilyTopic: "news",
    rationale: "Claims about the future expire when the event happens; most announced events are within a year.",
  },
  {
    id: "other.time_sensitive", label: "Other time-sensitive fact",
    describe: "Any other fact whose truth can change over time and that does not fit a class above.",
    lifetimeYears: 3, alpha: 1, evidenceRecencyDays: 365, tavilyTopic: "general",
    rationale: "Uninformative fallback: shape 1 (exponential prior) with a 3-year mean lifetime.",
  },
  {
    id: "science.consensus", label: "Scientific consensus",
    describe: "Established scientific understanding that can be revised slowly (e.g. 'Pluto is classified as a dwarf planet').",
    lifetimeYears: 30, alpha: 1.5, evidenceRecencyDays: 3650, tavilyTopic: "general",
    rationale: "Consensus revisions are rare, measured in decades.",
  },
  {
    id: "historical.fact", label: "Historical fact",
    describe: "A dated past event or fixed historical fact (e.g. 'The Berlin Wall fell in 1989').",
    lifetimeYears: 10000, alpha: 1, evidenceRecencyDays: 36500, tavilyTopic: "general", static: true,
    rationale: "Past events do not change; only corrections of error, which is out of scope for freshness.",
  },
  {
    id: "static.definition", label: "Definition or constant",
    describe: "A definition, mathematical or physical constant, or tautology (e.g. 'Water boils at 100 °C at sea level').",
    lifetimeYears: 100000, alpha: 1, evidenceRecencyDays: 36500, tavilyTopic: "general", static: true,
    rationale: "Definitional truths do not expire.",
  },
];

export const CLASS_IDS = CLASSES.map((c) => c.id);
const byId = new Map(CLASSES.map((c) => [c.id, c]));

export function getClass(id: string): ClassDef {
  return byId.get(id) ?? byId.get("other.time_sensitive")!;
}

export function isClassId(id: unknown): id is string {
  return typeof id === "string" && byId.has(id);
}

/** Prior Gamma rate β (in years) for a class. */
export function priorBeta(c: ClassDef): number {
  return c.alpha * c.lifetimeYears;
}

export const CLASS_TABLE_VERSION = "2026-11-02.1";
