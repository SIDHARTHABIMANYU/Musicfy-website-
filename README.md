Musicfy Frontend

The website/UI layer for Musicfy — an AI-integrated music platform where users can chat with an AI assistant to play music and get automatically surfaced concert booking suggestions.

Problem

Users needed a simple, chat-driven way to discover and play music, with no easy way to see live concert opportunities tied to what they're listening to.

Solution

Built the frontend interface that connects to the Musicfy backend's chat API to let users request songs conversationally, displays now-playing state and playback controls, surfaces concert booking cards inline when a relevant artist's song plays, and is deployed on AWS Amplify with CI/CD from GitHub.

Architecture

User Browser → Musicfy Frontend (AWS Amplify) → Musicfy Backend API (EC2) — chat, playback, booking

Tech Stack
Layer	Technology
Hosting	AWS Amplify
Integration	REST API calls to Musicfy backend
Key Features
Chat-driven song search and playback
Inline concert booking cards triggered by specific songs
Continuous deployment via AWS Amplify + GitHub
Setup

Clone the repo, run: npm install, then npm run dev

Environment Variables

Requires the backend API URL — see .env.example. None of these are committed to this repository.

Status

Built and deployed as part of an AI Engineering internship at Spinacle Technologies.
