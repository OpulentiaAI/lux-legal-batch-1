# Research update: Opulent on Luxembourg company law

Opulent AI Research · Prepared for François Bernard · September 30, 2026

Today we are sharing our first results on the corpus you gave us: a deliberately naive version of Opulent that outperforms Harvey's open-source legal agent harness on held-out Luxembourg company-law work.

In the eight days since your nine texts reached us, our research has pursued two aims:

1. Measuring legal work on Luxembourg law with evaluations a partner would recognize as real work; and
2. Establishing how much of an agent's legal performance comes from the system around the model, as distinct from the model itself.

This note reports where that work stands, including our first head-to-head result against the harness Harvey publishes with its Legal Agent Bench (LAB). The model we used is of modest capability by frontier standards, and the margin holds on every metric we report.

## Results

Our goal was to measure one thing as cleanly as we could: with the answering model held fixed, how much does the system around it change the quality of legal work? We ran both systems with GLM-5.3 on the most demanding set we built from your corpus, the twelve held-out tasks of our work-product suite, each a piece of client work specified by atomic criteria anchored in the exact text of your nine works. Opulent reaches 98 percent completion and outperforms Harvey's harness by at least 9.9 percentage points on every metric we report (Figure 1). With the answering model the same on both sides, the margin comes from what surrounds it: the harness, its tools and its retrieval, together with the access settings the appendix lists for each run. That it appears with a model of modest capability suggests the design is doing real work.

[[figure:results]]

Earlier runs on the same twelve tasks were closer. With DeepSeek V4.1 Flash and a 250-step budget, Opulent led on accuracy and grounding, 0.700 against 0.681 after removing each system's best and worst task (0.699 against 0.674 untrimmed), and the two were level on semantic quality, 0.907 against 0.892 trimmed and 0.894 against 0.891 untrimmed, with the individual tasks split almost evenly. A first 80-step run on these tasks ended with six of Opulent's twelve attempts at the step limit before a final answer. On the fifty-question development set, comparisons went both ways, depending on the model and the judge. We keep every run, and the appendix lists each one with the settings that differed between the two systems.

Opulent's runtime also answers questions well. On the fifty-question development set, with GPT-5 mini answering and judging under a three-tool, closed-corpus policy, the agent passes 93.8 percent of 178 atomic criteria, and 48 of its 50 answers are grounded in passages it actually read. Its first run scored 73.0 percent; the difference was a single rule in the harness's instructions, which we describe below.

Our second finding concerns the measurement itself. The work-product suite is built from your own texts, graded against their exact wording, and frozen before any system answers it. That makes it a fixed instrument: it can measure any system a firm is considering, ours included, on the law your practice actually uses, and it will measure the next model or harness in the same way.

Full details on our methodology are in the appendix.

## How we built it

Six pieces of work sit underneath these results: how we broke down your corpus, the evaluations and environments we built from it, the retrieval layer, the judge, the harness, and the head-to-head comparison. We describe each in turn.

### Breaking down the corpus

Your nine works arrived as 78 MB of scanned and digital PDFs: the law of 10 August 1915 on commercial companies in its consolidation of 29 May 2026; the company-law treatises of Steichen, Winandy, and Payen and Mbayi; volumes on obligations, commandites, accounting law and the Belgian reform; and your own monograph on cross-border demergers. We extracted about 15.5 million characters of French text, using OCR for scanned pages, and parsed each work along its own structure: livres, titres, chapitres and sections for the treatises, and articles for the statute and the annotated code. The result is a typed knowledge graph of 4,781 structural nodes and 2,018 article nodes, 365 of them from the 1915 law and 1,447 from the code of listed companies, divided into 8,809 passages (Figure 2). Each passage carries a stable citation to its work and to its place in that work, and each work is linked to its authors and to nine topics, from the primary statute to listed companies. An agent can therefore go straight to an article of the 1915 law, or to the passages of a treatise that discuss it, and cite exactly what it read.

[[figure:corpus]]

### Frontier evaluations and RL-ready environments

We built two evaluations from the corpus, and shaped the harder one as reinforcement-learning environments. The first is a development set of fifty questions across nine kinds of legal question, from statute lookups and definitions to doctrine, procedure, comparative and multilingual questions, graded against 178 atomic criteria. The second follows the design of Harvey's LAB: fifteen pieces of client work product, each framed as a partner's instruction to an associate, with 38 fictional client files and 101 criteria anchored to 59 exact passages of your corpus (Figure 3). The tasks ask for deliverables a Luxembourg practice produces, such as the closing sequence for a complete Luxembourg–France split, an allocation ledger with creditor stress tests for a partial European split, vote tabulations for parallel capital actions, and a financing choice between a Belgian SRL and a Luxembourg SARL. Separate model instances wrote and reviewed every packet against the source text, and the suite is frozen with cryptographic hashes, so any later change to a task or rubric is detectable. Each packet has the three parts of a training environment: an instruction, a client matter placed in a sandbox, and a rubric whose score can serve as the reward. Turning them into training environments needs two further steps, a training split kept apart from evaluation and clearance under the publishers' licences.

[[figure:evals]]

### Embedding and retrieval layers

Retrieval decides what a model can know, so we built it across several frontier and emerging services and measured the main configurations. Every passage is embedded with OpenAI's text-embedding-3-large at 3,072 dimensions and indexed in turbopuffer, beside a French full-text index that weights a work's title three times and its structural path twice as heavily as its body text. Vector and keyword results are fused, then reordered by a multilingual reranker. A second index, which the comparison runs use, embeds with Voyage 4 Large and reranks with Voyage's reranker, in namespaces of its own so that the two vector spaces never mix. Polygres, a Postgres service, holds a provenance mirror of every work and passage, so each citation joins back to its source record. On the development set, the first index with hybrid search and reranking returns the right passage first for 29 of 50 questions, against 20 for keyword search alone, raises mean reciprocal rank from 0.471 to 0.678, and places the right work in the top five for all 50 (Figure 4).

[[figure:retrieval]]

### Jev as a System 1 judge

Most of our grading uses reasoning judges that deliberate before they rule. They are thorough and slow, and they can run out of room: in one smoke test, a high-reasoning judge spent 15,852 tokens reasoning about a single answer and returned a truncated verdict. We have been exploring where a System 1 judge, fast and intuitive in Kahneman's sense, fits beside them. Jev rates a narrowly specified criterion in a single pass and returns a score together with a probability for each level of its scale, so it reports how sure it is along with what it concludes. In the 250-step comparison, Jev gave each attempt two holistic scores, for semantic quality and for accuracy and grounding. Its verdicts were short: 1,224 output tokens for all 24 attempts, about 51 each, after reading roughly 13,600 tokens of work product per attempt (Figure 5). That economy makes a new use practical: checking hyper-specific criteria, such as whether a vote tabulation uses the right denominator, on every draft, and passing only the uncertain cases to a slower judge or to a lawyer.

[[figure:judge]]

### A naive cloud harness, built from scratch

To test the harness question directly, we built a naive version of Opulent from scratch in the cloud: a standalone runtime that reconstructs the tool surface Opulent exposes, without the production application around it. A small control plane runs the model's turns, records every step and holds human approvals. Each agent works in its own E2B sandbox and sees 97 tools, with the corpus reachable through search, passage and inventory tools served over MCP. The agent can keep a persistent Python session and hand parts of a task to sub-agents, each in its own sandbox, the recursive pattern that suits long legal materials. We kept it plain on purpose: if a reconstruction of the Opulent design outperforms Harvey's harness, the advantage belongs to the design, and the production product can only add to it. Building it also showed how much small harness decisions matter. In its first development-set run, the agent pinned search filters that matched nothing and concluded that the evidence was missing. One added rule, to retry such a search without its filter before drawing that conclusion, raised criteria passed from 73.0 to 93.8 percent and cut degraded runs from 18 to zero, with the same model and judge (Figure 6).

[[figure:harness]]

### Harvey's open-source harness, head to head

[[figure:setup]]

For the comparison, we ran the harness Harvey publishes with LAB, the most complete open-source legal agent harness we know of: its own agent loop, prompts and six tools (bash, read, write, edit, glob and grep), pinned to a fixed public commit, with E2B sandboxes in place of its native container backend. Both harnesses receive identical task files and the same 8,809 passages of your corpus, run the same answering model under matched step and token budgets (Figure 7), and must save their work product to disk, where a missing file counts as a failure. We compare configured systems, so retrieval, prompts and tools differ along with the harness itself. Network access differed too: in the 250-step run, Opulent's sandboxes could reach the internet and Harvey's could not. The reference is Harvey's public harness; Harvey's hosted product was not part of the test. On those terms, the naive Opulent harness reaches 98 percent completion on the held-out tasks and leads by at least 9.9 points on every metric.

## What's next

This is a first result on your law, and a strong one. It shows that the system around a model can lift legal work substantially even at modest model intelligence, and that your corpus supports evaluations demanding enough to show it.

Next, we want to:

1. Bring lawyers into the grading. Our rubrics were written and checked with AI assistance against your texts, and are not yet certified by a lawyer. Ten development questions are already flagged for a lawyer's adjudication, where the question leaves a company form, jurisdiction or scope open. Review by your team would turn a strong measurement into an authoritative one.
2. Prepare training. The work-product packets already have the structure of reinforcement-learning environments. Training on them needs a training split kept apart from the evaluation tasks, and clearance under the publishers' licences, several of which restrict use for AI training.
3. Extend the corpus and the tasks to more of your practice, and run the full Opulent product beside the naive harness, reporting cost, token use and access settings alongside quality.

Legal work on Luxembourg law can be measured precisely, and the system around the model moves the result. We would welcome an hour with you to walk through the tasks, the rubrics and the results.

## Acknowledgements

We owe this work first to François Bernard, who gave us the corpus, including his own monograph on cross-border demergers. We are grateful to Harvey for publishing LAB and its harness in the open, which made this comparison possible, and to the teams behind the services we built on, including E2B, turbopuffer, Voyage AI, Polygres, code.storage, Vercel's AI Gateway and the makers of Jev.

## Appendix

Here we describe the evaluation design, retrieval, judging, harness configuration and paired runs in more detail.

### Evaluation design

The development set contains 50 questions: 16 fact questions, 10 on doctrine, 7 definitions, 4 statute lookups, 4 on procedure, 3 comparative, 3 multilingual, 2 on provenance and 1 survey question, graded against 178 atomic criteria in total. The judge receives the exact source text the model read. We treat this set as a development benchmark: it guided our work on retrieval and harness policy, and its rubrics have been through several reviewed versions.

The work-product suite contains 15 tasks built on the task, material and deliverable-scoped criteria of Harvey's public LAB design; it imports none of Harvey's legal answers. Every task requires a written memo that includes its requested tables, schedules, calculations or replacement clauses, drawn from 38 fictional client files in Markdown and CSV. The private rubric holds semantic pass or fail rules, minimal-pass and near-miss examples, and exact references to canonical passages and scenario facts. Tasks 01, 08 and 15 are reserved for development, smoke tests and judge calibration. The remaining twelve form the held-out set, which carries 83 of the 101 criteria and is always reported separately (Table 1).

[[table:heldout]]

Held out means that the twelve tasks took no part in developing or calibrating either harness before their first run. Every run since then, including the GLM-5.3 run, is a revised-protocol repeat on tasks already examined, so none of these results is an untouched holdout, and we report each run under its own protocol.

Review covered legal applicability, authority and date, arithmetic, scenario sufficiency, alternative valid interpretations and repeat penalties. It led to material corrections, among them requiring the actual capital threshold for an ordinary SARL, allowing a properly supported board-interim route for available reserves, and fixing the chronology of pre-approval and future contingency in task 11. The 2021 Belgian commentary is treated as secondary historical material, and outcomes that depend on foreign implementation, valuations or future approvals remain conditional in the rubric.

A freeze step binds the public inputs, the private rubrics, the protocol and all 8,809 canonical passage bodies into one hashed manifest. Public staging copies only each task and its declared materials into the answering sandbox, 53 files in all, and no rubric.

### Retrieval

Passages are cut along headings and article boundaries, up to 4,600 characters (roughly 1,100 to 1,200 tokens) with a 200-character overlap. The keyword leg is a French BM25 index over the passage text, the work's title and the structural path, weighted 1, 3 and 2. The vector leg uses text-embedding-3-large at 3,072 dimensions. The two are fused by reciprocal rank fusion and reordered by jina-reranker-v2-base-multilingual. Filters are inferred from article and statute references. When the top reranked result scores below 0.45, the neighbouring passages of the top hits in the same section are attached, without further index calls. The Voyage profile uses voyage-4-large at 1,024 dimensions with separate query and document input types, and rerank-2.5, in its own turbopuffer namespaces; we have not yet run the retrieval measurements on it. Table 2 gives the development-set results for the first index.

[[table:retrieval]]

### Judging

Every judge sees the evidence the model actually saw. A full passage reaches the judge only when its complete canonical text and citation appeared in the model's visible tool output; partial excerpts stay in the audit record and are never promoted to full sources. This can under-credit an answer built from partial excerpts, so we inspect those cases before attributing a gap to legal reasoning.

The development-set agent runs were answered and judged by GPT-5 mini. Later comparisons used reasoning judges, GPT-6 Luna and DeepSeek V4.1 Flash at high reasoning effort, with budgets of up to 32,768 output tokens, under versioned policies. Saved answers can be replayed under a new judge without being regenerated, so a score change from a replay is always a grading change and never an answering improvement. Jev (typesafe-ai/jev, through Vercel's AI Gateway) gives each attempt holistic scores on a four-level scale from 0 to 3, which we normalize to 0 to 1 by dividing by 3. In the 250-step comparison, the trimmed means, which drop each system's highest and lowest task for each metric, were chosen after the run, so we report the untrimmed means and the per-task win counts beside them.

### Harness configuration

The Opulent arm is a Node 24 control plane with SQLite records and E2B sandboxes for execution and desktop work. Its catalog lists 97 tools and 13 explicit exclusions, including the voice, wiki and settings surfaces. The corpus tools are served by a native MCP server and verified live before each run. A persistent Python kernel and a spawn tool give the agent recursive sub-agents, each in its own sandbox, with default limits of 64 tool calls per cell and 16 descendants. The 250-step profile removes those limits and opens general outbound networking from the sandbox, with inbound traffic still closed; code.storage was not configured for the comparison runs, so deliverables are collected from disk.

The Harvey arm uses Harvey's LAB agent loop, model adapter, prompts and six-tool executor from a fork pinned to commit 845a0884, with an E2B backend in place of its native Podman backend, and no internet access from its sandbox. Both arms run with source documents write-protected, and both receive the corpus as exported passages with stable citations, without questions, gold answers, rubrics or credentials.

### Comparison protocol

We declared the comparison protocol before the first work-product run. Later revisions, such as raising the step and completion-token budgets, applied to both sides at once and are recorded as revised-protocol results. Both harnesses answer from identical task files and the same corpus export, with matched step and completion-token budgets and the same answering model. Each keeps its own tools and instructions, and the requirement to save a written deliverable is given to both in the same words. Saved deliverables, transcripts, tool results, the evidence each model actually saw, elapsed time, tool counts and reported token use are collected before any sandbox is torn down. A missing deliverable is an execution failure and is never reconstructed from the final chat message. Recoverable tool errors stay visible without stopping the run. The protocol also rules out choosing favorable tasks, suppressing failed runs, changing budgets for one side, or tuning a judge toward a preferred winner, and it requires us to report where Opulent wins, ties or loses. Request timeouts and retries remain specific to each harness, and network access has differed between the arms; we report both asymmetries and do not claim identical resource envelopes.

### Paired runs

[[table:runs]]

Development-set runs overlap and are never added together. A 160-step repeat on the held-out tasks awaits grading.

### Limitations

1. Results for the GLM-5.3 run are as our team recorded them; its artifacts, metric definitions and access settings are being added to the repository.
2. Twelve paired tasks are a small sample. They describe performance on these tasks and are no proof of general superiority.
3. The twelve held-out tasks have been run several times, so results after the first run are revised-protocol repeats.
4. The rubrics are AI-assisted and source-reviewed, and not yet certified by a lawyer.
5. The comparison is against Harvey's public reference harness at a pinned commit. It says nothing about Harvey's hosted product.
6. Retrieval, prompts and tools differ by design, and in the 250-step run Opulent's sandboxes had internet access that Harvey's lacked.
7. In earlier runs Opulent used more tokens and time than Harvey's harness: in the 250-step run, 11.5 percent more answering tokens and a 54 percent higher median latency. We will report cost and latency for the GLM-5.3 run separately from quality.
