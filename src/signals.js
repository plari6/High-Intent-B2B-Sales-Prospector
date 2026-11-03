/**
 * Buying-signal library. Each signal says what happened, why it means the company
 * is likely to buy now, and how much it is worth in the score.
 *
 * Patterns are tested against the headline (full weight) and the first part of
 * the article summary (reduced weight, see detector.js).
 */

const FUNDING_VERB =
  String.raw`(?:rais(?:es|ed|ing)|secur(?:es|ed|ing)|lands?|landed|clos(?:es|ed|ing)|bag(?:s|ged)|nab(?:s|bed)|snag(?:s|ged)|banks?|banked|scor(?:es|ed)|picks? up|picked up|collect(?:s|ed)|attract(?:s|ed)|grab(?:s|bed)|rakes? in|raked in|pulls? in|pulled in|gets?|got|receiv(?:es|ed)|announc(?:es|ed)|complet(?:es|ed)|wins?|won)`;
const MONEY = String.raw`(?:(?:US)?\$|€|£|USD\s?|EUR\s?|GBP\s?)\s?(?:\d[\d,.]*\s?(?:k|m|mn|mm|million|b|bn|billion)\b|\d{1,3}(?:,\d{3}){2,})`;
const ROUND = String.raw`(?:pre-?seed|seed(?:\+|\s+extension)?|series\s+[a-h]\b(?:\+|\s+extension)?|angel|bridge|growth|venture|funding|financing|investment|round|capital|backing)`;
export const ROLE = String.raw`(?:CEO|CTO|CFO|COO|CRO|CMO|CIO|CISO|CPO|chief\s+[a-z]+(?:\s+[a-z]+)?\s+officer|(?:senior\s+)?(?:vp|svp|evp|vice\s+president)(?:\s+of)?\s+[a-z&]+(?:\s+[a-z]+)?|head\s+of\s+[a-z&]+|general\s+manager|managing\s+director|president)`;
const HIRE_VERB = String.raw`(?:hir(?:es|ed|ing)|appoint(?:s|ed|ing)?|names?|named|taps?|tapped|welcom(?:es|ed)|promot(?:es|ed)|brings?\s+(?:on|in)|brought\s+(?:on|in)|adds?|added|recruit(?:s|ed)|onboards?|elevat(?:es|ed)|selects?|selected)`;

export const SIGNALS = [
  {
    id: 'funding_seed',
    category: 'funding',
    label: 'Raised pre-seed/seed',
    weight: 34,
    why: 'Fresh seed money and a stack being built from scratch: first sales, marketing and ops tools get bought in the next 3-6 months.',
    angle: 'Help them turn the new round into pipeline fast without hiring a full team yet.',
    patterns: [
      new RegExp(String.raw`\b${FUNDING_VERB}\b(?:[^.]|\.(?=\d)){0,80}?\b(?:pre-?seed|seed)\b`, 'i'),
      /\b(?:pre-?seed|seed)\s+(?:round|funding|financing|investment|raise|capital|extension)\b/i,
      new RegExp(String.raw`${MONEY}\s+(?:in\s+)?(?:pre-?seed|seed)\b`, 'i'),
    ],
  },
  {
    id: 'funding_early',
    category: 'funding',
    label: 'Raised Series A/B',
    weight: 36,
    why: 'A Series A/B comes with a mandate to scale revenue: new hires, new tools and new vendors are approved now.',
    angle: 'Pitch speed: help the newly funded team hit the growth targets they promised investors.',
    patterns: [new RegExp(String.raw`\bseries\s+[ab]\b(?:\+|\s+extension)?(?!\s*(?:startups?|companies|investors?|funds?)\b)`, 'i')],
  },
  {
    id: 'funding_growth',
    category: 'funding',
    label: 'Raised Series C+ / growth',
    weight: 30,
    why: 'Late-stage money funds expansion and process maturity: tooling, automation and outsourced projects.',
    angle: 'Offer to automate the processes that break as headcount grows.',
    patterns: [/\b(?:series\s+[c-h]\b|growth\s+(?:round|equity|funding|financing))/i],
  },
  {
    id: 'funding',
    category: 'funding',
    label: 'Raised funding',
    weight: 30,
    why: 'Just raised money: budget is unlocked and the team is under pressure to show growth.',
    angle: 'Congratulate them on the round and show how you shorten time-to-revenue.',
    patterns: [
      new RegExp(String.raw`\b${FUNDING_VERB}\b[^.]{0,40}?${MONEY}`, 'i'),
      new RegExp(String.raw`${MONEY}[^.]{0,30}?\b(?:${ROUND})\b`, 'i'),
      new RegExp(String.raw`\b${FUNDING_VERB}\b[^.]{0,60}?\b(?:funding|financing|investment|round)\b`, 'i'),
    ],
  },
  {
    id: 'exec_hire',
    category: 'leadership',
    label: 'New executive hired',
    weight: 32,
    why: 'New leaders review vendors and buy new tools in their first 90 days to show quick wins.',
    angle: 'Reach the new exec early with a quick win for their first 90 days.',
    patterns: [
      new RegExp(String.raw`\b${HIRE_VERB}\b[^.]{0,70}?\b(?:as\s+(?:its\s+|their\s+|the\s+)?(?:new\s+|first\s+|interim\s+)?)?${ROLE}\b`, 'i'),
      new RegExp(String.raw`\b(?:new|first|interim)\s+${ROLE}\b`, 'i'),
      new RegExp(String.raw`\bhiring\s+(?:a|an|its|their)?\s*(?:new\s+|first\s+)?${ROLE}\b`, 'i'),
      new RegExp(String.raw`\b${ROLE}\s+(?:search|hire|appointment)\b`, 'i'),
    ],
  },
  {
    id: 'exec_departure',
    category: 'leadership',
    label: 'Executive change',
    weight: 20,
    why: 'A leader is leaving: a replacement is coming and priorities (and vendors) are about to be reset.',
    angle: 'Get on the radar before the new leader picks their vendors.',
    patterns: [new RegExp(String.raw`\b${ROLE}\b[^.]{0,40}?\b(?:steps?\s+down|stepping\s+down|resign(?:s|ed)?|to\s+depart|departs|exits|leaves)\b`, 'i')],
  },
  {
    id: 'hiring_spree',
    category: 'hiring',
    label: 'Hiring / team growth',
    weight: 26,
    why: 'Fast hiring means onboarding, tooling and process gaps that need solving now.',
    angle: 'Help them scale the team without the processes breaking.',
    patterns: [
      /\b(?:hiring\s+spree|hiring\s+push|ramp(?:s|ing)?\s+up\s+hiring|doubl(?:e|es|ing)\s+(?:its\s+|the\s+)?(?:headcount|team|workforce)|plans?\s+to\s+hire|to\s+hire\s+\d[\d,]*|(?:add|adding|create|creating|hire|hiring)\s+\d[\d,]*\s+(?:new\s+)?(?:jobs|roles|employees|staff|engineers|people|salespeople|reps))\b/i,
      /\b(?:build(?:s|ing)?\s+out|expand(?:s|ing)?|grow(?:s|ing)?)\s+(?:its\s+|their\s+)?(?:sales|go-to-market|gtm|revenue|marketing|engineering|customer\s+success)\s+(?:team|org|organization)\b/i,
      /\bis\s+hiring\b/i,
    ],
  },
  {
    id: 'expansion',
    category: 'expansion',
    label: 'Expansion / new market',
    weight: 22,
    why: 'Entering a new market or opening an office needs local pipeline, new processes and new vendors.',
    angle: 'Offer pipeline and automation for the new market they are entering.',
    patterns: [
      /\bexpand(?:s|ed|ing)?\s+(?:its\s+|their\s+)?(?:operations\s+|presence\s+|footprint\s+|business\s+)?(?:into|to|in|across)\b/i,
      /\bopen(?:s|ed|ing)?\s+(?:a\s+|its\s+|their\s+)?(?:new\s+|first\s+)?(?:\w+\s+)?(?:office|hq|headquarters|hub|engineering\s+center)\b/i,
      /\b(?:enter(?:s|ed|ing)?|launch(?:es|ed)?\s+in)\s+(?:the\s+)?(?:us|u\.s\.|uk|european|europe|asian|asia|gcc|mena|latam|indian|german|french|uae|saudi|north\s+american|apac)\b/i,
      /\binternational\s+expansion\b/i,
    ],
  },
  {
    id: 'stealth_launch',
    category: 'launch',
    label: 'Out of stealth',
    weight: 26,
    why: 'Just went public with the company: go-to-market starts now and almost nothing is bought yet.',
    angle: 'Be the first vendor helping their launch turn into customers.',
    patterns: [/\b(?:emerg(?:es|ed|ing)|comes?|came|coming|steps?|launch(?:es|ed)?)\s+(?:out\s+of|from)\s+stealth\b/i, /\bstealth\s+mode\b/i],
  },
  {
    id: 'product_launch',
    category: 'launch',
    label: 'Product launch',
    weight: 14,
    why: 'A launch means a push for users and revenue: demand gen, onboarding and support load go up.',
    angle: 'Help them get the launch in front of buyers and handle the inbound.',
    patterns: [/\b(?:launch(?:es|ed)|unveil(?:s|ed)|debut(?:s|ed)|introduc(?:es|ed)|rolls?\s+out|rolled\s+out)\b/i, /\bgenerally\s+available\b|\bgeneral\s+availability\b/i],
  },
  {
    id: 'acquisition',
    category: 'mna',
    label: 'Acquisition / merger',
    weight: 16,
    why: 'Mergers create integration work: systems, CRMs and teams have to be combined.',
    angle: 'Offer to merge their systems and data so the deal pays off sooner.',
    patterns: [/\b(?:acquir(?:es|ed)|acquisition\s+of|to\s+acquire|merg(?:es|ed)\s+with|merger\s+with|buys|bought)\b/i],
  },
];

/** Stories that are not about one company buying anything (guides, roundups, opinion). */
export const NOISE_PATTERNS = [
  /\b(?:how\s+to|tips\s+(?:for|on)|guide\s+to|lessons\s+from|what\s+(?:vcs|investors|founders)|why\s+(?:vcs|investors|founders))\b/i,
  /\b(?:week['’]?s?\s+(?:biggest|top|\d+)|biggest\s+(?:funding\s+)?rounds|funding\s+(?:roundup|recap|report|data)|roundup|recap|this\s+week\s+in|week\s+in\s+review|daily\s+digest|newsletter|podcast|webinar|livestream)\b/i,
  /^\s*(?:the\s+)?(?:top\s+)?\d+\s+(?:startups|companies|best|biggest|ways|things|reasons)\b/i,
  /\b(?:vc\s+firm|venture\s+firm|fund)\s+(?:raises|closes|launches)\b|\bcloses\s+(?:\$[\d.]+\w*\s+)?(?:fund\s+[ivx\d]+|new\s+fund|debut\s+fund)\b|\b(?:debut|new|first|second|third|fourth|fifth)\s+fund\b|\bfund\s+[ivx]+\b/i,
  // A VC raising its own fund: "$750M fund", "€15 million debut fund", "€668 million CVIII fund", "Swedish VC Creandum".
  /\d[\d.,]*\s?(?:k|m|mn|million|b|bn|billion)?\s+(?:[\w-]+\s+){0,3}?(?<!\b(?:to|will|help|helps|and)\s)fund\b(?!ing)/i,
  /\b(?:solo\s+)?(?:vc|gp|lp|venture\s+capitalist)s?\s+[A-Z][\w-]+(?:\s+[A-Z][\w-]+)?\s+(?:raises|closes|launches)\b/,
  // Market reports, not one company.
  /\b(?:funding|deals?|rounds?|investment)\s+(?:is|are)\s+(?:up|down)\b|\bsector\s+snapshot\b|\b(?:global|venture)\s+(?:venture\s+)?funding\s+(?:to|in|hits|tops|falls|rises|lifts|climbs|drops)\b|\bheads?\s+toward\b|\bhiding\s+the\b/i,
];

/** Distress signals. Leads with these are dropped: they are cutting spend, not buying. */
export const DISTRESS_PATTERNS = [
  /\blay(?:s|ing)?\s+off\b|\blayoffs?\b|\bcuts?\s+\d[\d,]*\s+(?:jobs|roles|staff|employees)\b|\bjob\s+cuts\b/i,
  /\bshut(?:s|ting)?\s+down\b|\bwind(?:s|ing)?\s+down\b|\bbankrupt|\binsolven|\bceases?\s+operations\b|\b(?:enters?|entered|goes\s+into|went\s+into|placed\s+into)\s+administration\b|\bfiles?\s+for\s+chapter\s+(?:7|11)\b/i,
];

export const SIGNAL_BY_ID = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));

/** Builds keyword signals from user phrases like "raised seed" or "hiring CEO". */
export function keywordSignals(phrases = []) {
  return phrases.map((phrase) => {
    const words = phrase.trim().split(/\s+/).map(escapeRegex);
    return {
      id: `kw:${phrase.toLowerCase()}`,
      category: 'keyword',
      label: `Keyword: "${phrase}"`,
      weight: 24,
      why: `Matches your keyword "${phrase}".`,
      angle: '',
      patterns: [new RegExp(String.raw`\b${words.join(String.raw`[\s-]+(?:\S+[\s-]+){0,3}?`)}\b`, 'i')],
    };
  });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
