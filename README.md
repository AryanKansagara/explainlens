# ExplainLens

Visual MongoDB explain() plan tree with findings and index advice.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Test

```bash
npm test          # unit tests (Node's built-in runner)
npm run test:e2e  # builds, then runs the Playwright (Chromium) suite against `vite preview`
```

The E2E suite lives in `e2e/` and runs against the production build served by `vite preview` on port 4417; set
`E2E_PORT` to use another port. Install the browser once with `npx playwright install chromium` (add `--with-deps` on a
fresh Linux machine). Tests are signed out, block every host except the local server (the web fonts are refused, not
fetched) and fail on uncaught page errors. Inputs are the built-in synthetic samples, explain output copied from the
MongoDB manual (sources in [`e2e/fixtures/README.md`](e2e/fixtures/README.md)) and one synthetic sharded document. Tests
marked "known bug" use `test.fail()`: they document an open app issue and start failing once it is fixed, which is the
cue to turn them into plain tests.

CI (`.github/workflows/ci.yml`, job `test`) runs install, build, unit tests and E2E on every pull request and push to
`main`, with the Playwright browser cached by its version.

Light and dark themes follow [Material Design 3](https://m3.material.io/).
