# Letonika Broken Image Agent

This project scans Letonika Events records and finds broken images inside event content using Node.js (>=20) and Playwright.

Prerequisites

- Node.js 20+
- npm

Installation

1. Clone the repository

   git clone https://github.com/JustAnitaV/letonika-broken-image-agent.git
   cd letonika-broken-image-agent

2. Install dependencies

   npm install

3. Install Playwright browsers

   npx playwright install

Configuration

1. Copy .env.example to .env and set your credentials:

   cp .env.example .env
   # then edit .env and set LETONIKA_USER and LETONIKA_PASSWORD

Environment variables

- LETONIKA_USER - Letonika username
- LETONIKA_PASSWORD - Letonika password

Usage

Start the scanner:

   npm start

What it does

- Logs into https://letonika.lv/editor/ with provided credentials
- Opens the Events editor listing: https://letonika.lv/editor/FrontPageEditor.aspx?type=Events
- Iterates event IDs from 1 to 6000 and opens https://letonika.lv/editor/FrontPageEditor.aspx?type=Events&id={id}
- Skips invalid or empty records
- Extracts Event ID and Title
- Finds all IMG elements inside the editor content (including iframes)
- Marks an image as broken when image.complete is false OR image.naturalWidth === 0 OR image.naturalHeight === 0
- Appends findings to reports/report.csv with columns: EventID,Title,ImageURL
- Saves a screenshot of every record that has at least one broken image into screenshots/{id}.png
- Displays progress in the console

Project structure

- src/
  - scan-events.js
- reports/
  - report.csv (generated)
- screenshots/
  - (generated)

Notes

- The scanner uses heuristics to locate login fields and the event title; if the Letonika editor changes its DOM, you may need to adjust selectors in `src/scan-events.js`.
- Be polite when scanning a remote site. Consider adding delays or running smaller ID ranges if necessary.
