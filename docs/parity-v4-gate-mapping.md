# Parity v4 Gate Mapping and Seam Specification

## Metric Trace and Classification

| Computed Metric or Check | Production Implementation | Role in Record and Aggregate | Required v4 Disposition |
|---|---|---|---|
| Physical reference energy error | Python parity-contact-sheets.py | Mandatory physical gate | sum(abs(premul(ref) - premul(cand))) / sum(premul(ref)) over entire fixed viewport. Threshold <= 0.10. Gated. |
| Physical reference energy score | Python parity-contact-sheets.py | Diagnostic display | max(0.0, 1.0 - physical_error). Displayed in table and JSON. |
| Composited foreground score | Python parity-contact-sheets.py | Secondary diagnostic | Union denominator in ink box. Does not override physical gate failure. |
| Foreground alpha score | Python parity-contact-sheets.py | Secondary diagnostic | Union alpha delta. Does not override physical gate failure. |
| Ink coverage ratio | Python parity-contact-sheets.py | Secondary anti-collapse check | min(n_skia, n_rust) / max(n_skia, n_rust) >= 0.50. Gated. |
| Ink pixel counts | Python parity-contact-sheets.py | Secondary anti-collapse check | n_skia >= min_ink and n_rust >= min_ink. Gated. |
| Global mean RGB and alpha delta | Python parity-contact-sheets.py | Secondary diagnostic check | Upper bounds enforced. Cannot rescue physical failure. |
| Rust bbox dimensions | Python parity-contact-sheets.py | Secondary anti-collapse check | width and height >= 16 * dpr. Gated. |
| Rust mean ink alpha | Python parity-contact-sheets.py | Secondary diagnostic check | Mean alpha on ink support. Cannot rescue physical failure. |
| Outside bbox alpha max | Python parity-contact-sheets.py | Secondary anti-flood check | Outside combined ink bbox must be 0. Gated. |
| Foreground premultiplied RGBA score | Python parity-contact-sheets.py | Diagnostic | Undiluted premultiplied difference in ink box. |
| Strict dimensions and hash checks | Python and JavaScript harnesses | Critical precondition | Viewport width * DPR and height * DPR must match exactly. Mismatch throws exit 2. |
| Schema and semantic contracts | JavaScript parity-integrity.cjs | Authoritative validation | Manifest schema, Cartesian matrix, TTML syllables, 120 Hz history, settings, geometry. |
| Determinism repeat equality | JavaScript parity-compare.cjs | Determinism verification | Live two-pass byte equality. Replay marks unverified. |
| ABI3 style identity | JavaScript parity-compare.cjs | Capability honesty | Baseline requires identical Rust rasters across styles. |
| accepted_parity | Python and JavaScript harnesses | Parity status | Baseline and replay always false. Cannot be true while styles or fonts are unsupported. |
| gate_passed | Python and JavaScript harnesses | Per-record gate | True only if physical_passed and all secondary checks pass. |
| baseline_passed | Python and JavaScript harnesses | Legacy synonym | Strictly equals gate_passed. Never true when physical_passed is false. |

---

## Acceptance Case to Production Function Mapping

| Case Family | Production Function | Record Gate | Aggregate JSON Status | Default Strict Exit | Diagnostic Mode Exit |
|---|---|---|---|---|---|
| C01 (Canonical live) | main(), runCapture(), validateInputs(), Python | physical_passed: false (error > 0.10), gate_passed: false | status: "DIAGNOSTIC_FAILED", accepted_parity: false, determinism_verified: true | Exit 1 | Exit 0 |
| C02 (Canonical replay) | evaluateBundle(), validateSinglePassInputs(), Python | physical_passed: false, gate_passed: false | status: "DIAGNOSTIC_FAILED", accepted_parity: false, acquisition: "replay" | Exit 1 | Exit 0 |
| P01-P07 (Adversarial attacks) | evaluateBundle(), Python compute_physical_error() | physical_passed: false, failure_reasons: ["PHYSICAL_ERROR_EXCEEDED"] | status: "DIAGNOSTIC_FAILED", accepted_parity: false | Exit 1 | Exit 0 |
| P08 (Zero-alpha RGB mutation) | evaluateBundle(), Python compute_physical_error() | physical_error and scores byte-for-byte identical to baseline | Same as C01/C02 | Exit 1 | Exit 0 |
| P09 (Added blank alpha) | evaluateBundle(), Python compute_physical_error() | physical_error nondecreasing across sets | Same as C01/C02 | Exit 1 | Exit 0 |
| P10 (Total empty or 1px candidate) | evaluateBundle(), Python empty raster assertion | Empty raster throws INVALID_EMPTY | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| P11 (Dimension mismatch) | Python strict dimension assertion | Mismatched dimensions throw DIMENSION_MISMATCH | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| P12 (Stricter threshold) | evaluateBundle(), Python physical threshold gate | physical_threshold tightened, physical_passed: false | status: "DIAGNOSTIC_FAILED" | Exit 1 | Exit 0 |
| P13 (Loosened threshold) | validateManifestSchema() | max_physical_error > 0.10 rejected as INVALID_PHYSICAL_THRESHOLD | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| M01-M07 (Manifest mutations) | validateManifestSchema() | Schema or contract mismatch rejected | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| X01-X03 (Matrix coverage) | validateMatrixCoverage() | Non-12 records or duplicate/missing IDs rejected | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| S01-S05 (Semantic mutations) | validateSinglePassInputs() | History, geometry, settings, syllables, or packet mismatch rejected | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| I01-I03 (Inventory mutations) | validateSinglePassInputs(), validateInventories() | Duplicate sources, incomplete closure, or stale attestation rejected | status: "INVALID_INPUT", records: [] | Exit 2 | Exit 2 |
| R01-R03 (Repeat determinism) | main() two-pass check, evaluateBundle() | Live mismatch throws NONDETERMINISTIC_CAPTURE. Replay unverified. | status: "INVALID_INPUT" on live mismatch | Exit 2 on R01 | Exit 2 on R01 |
| B01-B06 (Build preflight) | validateBuildEnvironment() | Unsupported compiler env, flags, or cargo config rejected | status: "INVALID_BUILD_ENV", records: [] | Exit 2 | Exit 2 |

---

## Minimal Seam Specification

Command:
```bash
node scripts/parity-compare.cjs --evaluate <bundle-directory> [--output <dir>] [--manifest <path>] [--diagnostic] [--json]
```

Schema of `<bundle-directory>`:
- Must contain `capture-manifest.json` (or `captures/capture-manifest.json`).
- If `repeat/capture-manifest.json` is present, both passes are evaluated and verified.
- PNG files referenced in records must exist on disk and match their recorded SHA256 digests.
- Replay skips Cargo compilation and runs authoritative single-pass and cross-pass validation.
- Replay records provenance:
  - `acquisition: "replay"`
  - `determinism_status: "UNVERIFIED_REPLAY"`
  - `determinism_verified: false`
  - `accepted_parity: false`
- Replay runs the exact production Python metric script and decision logic.
- Exit codes:
  - Exit 0 in `--diagnostic` mode if comparison valid (status `DIAGNOSTIC_FAILED`).
  - Exit 1 in default strict mode if comparison valid but physical error > 0.10.
  - Exit 2 if input bundle or manifest fails validation.
