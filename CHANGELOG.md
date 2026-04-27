# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/typos default [on|off]` subcommand and persistent extension configuration (`~/.pi/agent/mobile-autocorrect-config.json`, override with `MOBILE_AUTOCORRECT_CONFIG_PATH`) to control the autocorrect mode new sessions start in. The bootstrap value is `off`, preserving prior per-session behavior; setting it to `on` reconciles every `session_start` event to enabled. Reconciliation is bidirectional and silent when state already matches.

## [0.1.0] - 2026-04-26

### Added

- Real-time mobile-friendly autocorrect for Pi's editor with word-by-word correction on space and punctuation triggers.
- A layered dictionary system combining a learned dictionary, a bundled tech-term whitelist, and SymSpell English suggestions.
- Learned-dictionary persistence with manual `/typos dict` management commands.
- `/typos`, `/typos on`, and `/typos off` commands for per-session enable/disable control.
- Gboard-style immediate backspace undo for the most recent correction, including rejection-based auto-learning.
- Automated integration coverage for autocomplete non-interference, toggle lifecycle behavior, token eligibility, and case preservation.

### Notes

- Tag with `git tag v0.1.0 && git push --tags` once integration tests pass on the user's mobile setup.
