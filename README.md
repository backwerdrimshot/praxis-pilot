# Praxis pilot — deploy mirror

Public GitHub Pages deploy of the two Praxis pilot prototypes (Notion doc 14d):

- `copy-the-sticking/` — Stick Lab two-trigger MVP (A2 controller sequence + A1 recall)
- `count-it-contract/` — Count It knowledge quiz (A1 answer correctness, non-controller contract proof)

**Source of truth is the private `praxis-platform` repo** (`apps/` directory). Do not edit
these files here — copy them over from `praxis-platform` and commit:

```
cp -R ../praxis-platform/apps/copy-the-sticking ../praxis-platform/apps/count-it-contract .
```

Both apps must stay on the same origin: the cross-app skill profile reads both apps'
`localStorage` results. No accounts, no analytics, no student data leaves the device.

© 2026 Backwerd Rimshot, LLC. All rights reserved.
