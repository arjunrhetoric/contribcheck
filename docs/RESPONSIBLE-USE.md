# Responsible use (for instructors and TAs)

contribcheck produces **evidence for human review**. It does not grade, rank, or judge students. A number in a report is a question to ask, not an answer.

## Before the project starts

1. **Tell students what is measured.** Share this document and `docs/METHOD.md`. Explain that commits, co-author trailers, surviving lines, deadlines, and (optionally) GitHub PR activity will be looked at.
2. **Agree on identities.** Ask each student to add every email they will use to `roster.csv`, and their GitHub login if PR data will be collected. Explain that unresolved identities go to `unattributed` rather than being guessed.
3. **Agree on workflow.** Tell students to use `Co-authored-by:` trailers for pair work, commit regularly, and avoid force-pushing history you may need.
4. **Say what is not measured.** In-person pairing, design discussions, research, manual testing, and mentoring may not appear in git. The tool cannot see them, and neither should your grading treat absence as proof of no work.

## While reviewing

1. **Never use the composite alone.** It is off by default for a reason. If it is enabled, read the formula and each component, and read the flags and evidence beside it.
2. **Review every flag with the student.** Flags are prompts, not findings. `LOW_SHARE` can mean pair work or non-code contributions. `LARGE_COMMIT` can mean a bulk import. `DATE_ANOMALY` can mean a wrong system clock. `UNRESOLVED_IDENTITY` usually means a missing email.
3. **Give students the student view.** `contribcheck explain <memberId> --view student --format md` shows only their own metrics and anonymized team totals, with no other members’ numbers and no emails.
4. **Look at the evidence, not just totals.** Check short/full SHAs, file paths, PR numbers, and blame-derived counts. Ask the student what happened.
5. **Compare like with like.** A student who wrote documentation or tests may have low churn but high value. A student who refactored may have low surviving lines because they moved code.

## Bias and fairness

Git history systematically underrepresents:

- design, documentation, research, and manual testing;
- pairing done in person, on calls, or via live share without co-author trailers;
- work by students who write commit messages in another language (their commits are still counted, but reviewers may misread subjects);
- work by students with unstable machines, unreliable internet, or shared accounts;
- work that was squashed or force-pushed away.

Students from underrepresented groups may also be less likely to claim credit publicly. Use the tool to start a conversation, not to settle one.

## Privacy and retention

- `analysis.json` contains emails and is sensitive. Store it where only instructors can read it.
- Use `--redact` for anything shared more widely.
- Delete analyses and caches once grades are final: `contribcheck purge --yes`, then remove any copies you exported.
- Do not commit `contribcheck-out/` or `.contribcheck/` to a shared repository.
- Tell students what data is collected and how long it is kept.

## Legal note (not legal advice)

Depending on where your students are, student-privacy rules may apply. In the United States, FERPA governs education records at many institutions. In the EU and UK, GDPR and the UK GDPR govern personal data processing, including lawfulness, minimization, retention, and access requests. Other countries have their own rules. Consult your institution’s privacy office or legal counsel; this document is not legal advice.

## If something looks wrong

1. Reproduce the scan with `--no-timestamp` and keep the output.
2. Check repository health: shallow clone, missing ref, rewritten history, unresolved identities.
3. Ask the student which emails and GitHub logins they used.
4. If the tool is wrong, fix the input and re-run. Do not hand-adjust numbers; record context in `adjustments.yaml`, which is displayed but never changes computed values.
