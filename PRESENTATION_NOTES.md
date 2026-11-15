# HALFLIFE presentation notes

Deck: `HALFLIFE_Project_Presentation.pptx` (18 slides, 16:9, editable). Assets and the generator: `presentation_assets/`. Slide renders for review: `presentation_assets/previews/`. Each slide also carries speaker notes.

Built from the repository at commit `0fbab4b`. Technical claims were checked against the source (`engine/src/*.ts`, `plugin/main.go`, `extension/`, `deploy/render-config.mjs`) and the project records. The engine suite was re-run while building the deck (76/76, 2026-11-15). No application code, configuration, database or running service was changed. Nothing was committed or pushed.

## Slide by slide

| # | Title | What it communicates | Visual |
|---|---|---|---|
| 1 | HALFLIFE (cover) | Product name, one-line definition, hackathon, Problems 04 and 06 | Survival curves computed from the real class priors (`classes.ts`): market price, software version, office holder, historical fact |
| 2 | AI answers expire, one claim at a time | One answer contains claims with very different lifetimes | Illustrative answer built from the class examples in `classes.ts`, with each claim's prior typical lifetime on a log bar |
| 3 | Uniform checking spends in the wrong places | Why checking nothing, checking whole answers, or checking every claim falls short | Qualitative cost/exposure chart (labelled as not a measurement), four reasons |
| 4 | Claim-level freshness, from answer to evidence | What HALFLIFE does; the six-stage pipeline; entry points; not a universal fact-checker | Pipeline diagram |
| 5 | Every claim class has its own rate of change | The freshness model: 18 classes, Gamma-Poisson P(outdated), θ = 20%, reuse window, learning; three measures kept apart; uncalibrated | Native chart of every class's prior lifetime with 90% prior interval |
| 6 | Two deployables: a gateway plugin and an engine | Real component layout and data flows, colour-coded by kind (user input, internal, model, web retrieval, results) | Architecture diagram |
| 7 | Eight steps from a selected answer to a verdict | Identification vs freshness assessment vs evidence verification, with the source file for each step | Two-row flow |
| 8 | Check an answer where you read it | The ChatGPT extension end to end on real chatgpt.com: the Check freshness button, the compact result in place, the full report in the console; how pairing and local analysis work | Three real chatgpt.com screenshots supplied by you (2026-11-15), cropped |
| 9 | Every claim gets its own verdict and evidence | How to read a report: claims in place, verdicts, summary, cache action, spend, current value, three measures, evidence rules | Real screenshots 01 and 06 (cropped) with 8 numbered callouts |
| 10 | One console for every report | What the console lets an operator inspect | Screenshot 03 plus crops of 08, 07 and 11 |
| 11 | A gateway extension, not an app beside the gateway | Problem 04: the six hooks, the supported extension points used, no core changes, measured hook cost, not upstreamed | Hook table, extension-point list, stat tiles |
| 12 | Live evidence, spent only where risk is high | Problem 06: T0/T1/T2 ladder, evidence-level rules, a real superseded claim with quote-verified sources | Ladder diagram, crop of screenshot 06 |
| 13 | Small, dependency-free components with hard boundaries | Code organisation per component, with line counts and design principles | Component map |
| 14 | Safeguards that exist in the code today | Key isolation, caller credentials, extension pairing, untrusted-text handling, local data; six spend layers; stated limits | Spend funnel |
| 15 | Automated suites, and what real-world runs showed | Test results with dates and coverage; FreshQA results; caveats including the flaky extension run | Stat tiles |
| 16 | What is not solved yet | Limitations and possible next steps (none started) | Table |
| 17 | How HALFLIFE answers both problems | Requirement-by-requirement evidence for Problems 04 and 06 | Two-column evidence grid |
| 18 | Information has a lifetime | Closing message and product line | The cover's curves again |

## Screenshot placeholders to replace

None. Every image slot holds a real screenshot. Slides 9, 10 and 12 use `docs/assets/screenshots/`. Slide 8 uses the three chatgpt.com screenshots you supplied (originals in `presentation_assets/screenshots/real-chatgpt-*.png`). No TEST FIXTURE screenshot is used any more.

The slide 8 crops cut away only two things: the account avatar (bottom-left of the result screenshot) and the report header row in the console screenshot, whose timestamp shows your local time zone (UTC+05:30). Nothing else was changed. These screenshots are not in `docs/assets/screenshots/`. Add them there yourself if you want them in the repository.

## Please confirm

1. **Repository link.** Slides 1 and 18 show `github.com/fazeprism25/halflife` (the public repo from the README). Remove it if you don't want it on the slides.
2. **Test figures.** Engine 76/76 was re-run on 2026-11-15. Console UI 15/15, extension 14/14 and integration 13/13 come from the session-15 records (2026-11-03). Go plugin 21/21 is from 2026-11-02 and was not re-run. They were not re-run for the deck because they need Edge, Docker or port 8080.
3. **Problem wording.** Slide 17 follows the brief you gave. The project records say the official Problem 04/06 wording and rubric were never confirmed from a public page, and the slide says so.
4. **Slide 2 example answer.** It is assembled from the example sentences in `engine/src/classes.ts` ("Bitcoin trades at $60k", "Satya Nadella is CEO of Microsoft", and so on). The slide labels them as examples of claim types, not verified facts. Swap them if you prefer different examples.
5. **Slide 3** is a qualitative illustration, labelled as such. It does not describe how any specific AI product behaves.
6. **"≈42 µs".** Slide 11 uses the hook timing from `docs/ARCHITECTURE.md` (all hooks for one request, Docker, 4 CPUs).
7. **Line counts (slide 13)** are non-test source lines from `git ls-files` today: plugin 1,262; engine/src 3,715; console 2,860; extension 1,011 (`src/` + `popup/`).
8. **Real data shown as captured.** Slides 9, 10 and 12 show real development reports, including the UK prime-minister example (Keir Starmer superseded by Andy Burnham, 2026-07-20, per the stored sources) and your chatgpt.com question as typed ("who is hte prime minister of uk"). Nothing was edited.
9. **Fonts.** The deck uses Segoe UI, Consolas and Cambria. They are present on Windows and Office. On macOS or Google Slides, Segoe UI is substituted and some lines may wrap differently. Check the deck there if it will be presented from one of those.
10. **Slide 8 screenshots.** They come from your real check on 2026-11-15. The engine reported 2 claims, 1 time-sensitive, checked live, current, with strong evidence. The second claim (took office 20 July 2026) was not time-sensitive and was not checked. The chat title "UK Prime Minister Inquiry" is visible in the original but falls outside the crops.
11. **Screenshots predate the latest commit.** They were captured at `a2a296e`. The later commit `0fbab4b` changed only documentation, so the UI is the same.
