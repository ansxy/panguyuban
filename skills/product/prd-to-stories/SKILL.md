---
name: prd-to-stories
description: Turn an approved prd.md into a build plan — for each step, how big it is and whether an engineer has to clear it before it is built. Use right after the user approves the PRD, before set up.
---

# PRD to Build Plan

The user has approved a PRD. Before anything is built, you decide two things for each step in section 4: **how big it is** and **whether an engineer must clear it first**. The app uses your answer to pick which agent builds each step and to stop steps that need an engineer.

The reader of your reasons is the same non-technical user who answered the interview. Write for them.

---

## 1. What you may not change

- The steps themselves: their ids (`S1`, `S2`, ...), names, order and acceptance criteria. You plan what was approved; you do not rewrite it.
- The number of steps. Do not add, merge, split or drop one. If two steps cannot sensibly be built apart, say so in the reason of the later one.
- The scope. Anything under *Later* or *Not doing* stays out.

## 2. Size: `small` or `hard`

Judge each step by what has to be true for its acceptance criteria to pass.

**small** — one screen or one action, with little to decide:
- showing a list or a page of sample data
- a simple form that adds, ticks or removes one thing
- text, labels, an empty-state message, a button that goes somewhere

**hard** — more than one moving part, or easy to get subtly wrong:
- information that must stay consistent across several screens or steps
- rules and calculations (totals, statuses that depend on dates, who may do what)
- several stages in a row, such as submit, review, approve
- searching, filtering or sorting combined with paging
- anything the later steps all depend on

When unsure, choose `hard`. A step sized too small costs a failed attempt; one sized too big only costs a little more.

## 3. Needs an engineer: `true` or `false`

Set `needs_engineer` to `true` only when section 6 (*Real or pretend*) or the step itself says something must **really** reach outside the prototype:

- signing in with the client's or the company's real accounts
- reading from or writing to a real system (a client system, a company database, a live service)
- sending real email, SMS or chat messages
- taking a payment
- importing a real file or real records
- any real personal, patient, policyholder or client-staff data, in any form

If the PRD marks the thing as pretend, or it runs on made-up sample data inside the prototype, it does **not** need an engineer. A todo list, a sample claims list, a pretend sign-in screen: all `false`.

## 4. The reason

One short sentence per step, in plain language, saying why you chose that size and, if flagged, what the engineer has to agree to.

- Good: "One screen showing sample claims, nothing depends on it yet."
- Good: "Signing in with the client's own accounts touches their real system, so an engineer has to agree first."
- Bad: "Requires state management and API integration."

No technical terms. Reply in the language the PRD's content is written in.

## 5. What you send back

Only this, and nothing outside the tags:

```
<plan>
{
  "summary": "<one or two sentences for the user: how many steps, how many are hard, which need an engineer>",
  "steps": [
    { "id": "S1", "size": "small", "needs_engineer": false, "reason": "<one sentence>" }
  ]
}
</plan>
```

Every step in section 4 of the PRD appears exactly once, in the same order. Valid JSON: double quotes, no trailing commas, no comments.
