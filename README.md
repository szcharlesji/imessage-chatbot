# iMessage LLM Chatbot (Bun + SQLite + AppleScript)

This project creates a chatbot that interacts within your macOS iMessage application. It monitors specified conversations, uses an OpenAI-compatible Large Language Model (LLM) to generate replies based on the conversation context, and sends these replies back through the Messages app.

The bot reads message history directly from your local `chat.db` SQLite database and uses AppleScript to send outgoing messages, making it entirely dependent on running on a macOS machine with iMessage configured.

## Prerequisites

- **Permissions:** You will likely need to grant specific permissions:
  - **Full Disk Access:** Your terminal application (e.g., Terminal, iTerm2, Ghostty, VS Code) might need Full Disk Access to read `~/Library/Messages/chat.db`. Grant this in `System Settings > Privacy & Security > Full Disk Access`.
  - **Automation:** Your terminal application will need permission to control the Messages app via AppleScript. You will likely be prompted the first time the script tries to send a message. Grant this in `System Settings > Privacy & Security > Automation`.

## Setup Guide

1.  **Clone or Download:**

    ```bash
    # If using git
    git clone <your-repo-url>
    cd <your-repo-directory>

    # Or download the project files and navigate into the directory
    cd /path/to/your/imessage-chatbot
    ```

2.  **Install Dependencies:** Although Bun includes most necessary tools, we use `dotenv` for configuration management.

    ```bash
    bun install
    ```

3.  **Create Configuration File:** Copy the example environment file to `.env`.

    ```bash
    cp .env.example .env
    ```

4.  **Configure `.env`:** Open the `.env` file in a text editor and fill in the required values.
5.  **Run the script:**

    ```bash
    bun index.ts
    ```

**Expected Output:**

- Connection logs for the SQLite database.
- The "Identifying Recent Chats" list (use this to verify/update `TARGET_CHAT_IDENTIFIERS` in `.env`).
- Initialization logs showing which identifiers are being tracked and the message ID baseline for each.
- "Starting iMessage Chatbot Server..." message.
- "Bun server listening on http://localhost:3000" message.
- Polling interval confirmation.
- Subsequently, logs for detected incoming iMessages, LLM queries, and sent messages will appear as activity occurs in the monitored chats.

4.  **Keep the Terminal Running:** The script needs to remain running in the terminal for the bot to function.
5.  **Stopping the Bot:** Press `Ctrl+C` in the terminal where the script is running. It should perform a graceful shutdown, closing the database connection and stopping the server.

## How It Works

1.  **Initialization:**
    - Loads configuration from `.env`.
    - Connects to the `chat.db` SQLite database (read-only).
    - Displays the 5 most recently active chats to help identify target identifiers.
    - For each `TARGET_CHAT_IDENTIFIER`, it queries the database to find the `ROWID` of the very last iMessage sent or received in that chat. This ID is stored as the baseline; the bot will ignore all messages up to and including this ID.
2.  **Polling Loop (`setInterval`):**
    - Every `POLL_INTERVAL_MS` milliseconds, the `checkAndRespondAllChats` function runs.
3.  **Check Cycle:**
    - The function iterates through each configured `TARGET_CHAT_IDENTIFIER`.
    - For the current identifier, it fetches the latest `MESSAGE_CONTEXT_LIMIT` iMessages using `fetchMessages`.
    - It checks if any _incoming_ iMessages (`is_from_me === 0`) have a `ROWID` _greater than_ the baseline ID stored for that chat.
4.  **LLM Interaction:**
    - If a new incoming iMessage is found:
      - The baseline ID for that chat is updated to the ID of the new message.
      - The fetched recent messages are formatted into a context array (including the `SYSTEM_PROMPT` and sender labels like "Me:"/"Them:").
      - `queryLLM` sends this context to the configured LLM API endpoint.
5.  **Sending Reply:**
    - If the LLM API returns a valid text response:
      - `sendIMessage` constructs an AppleScript command using the `buddy ... of service 1 ...` structure (found to be reliable).
      - Bun's `$` executes `osascript` to run the AppleScript, telling the Messages app to send the LLM's reply to the correct recipient.
6.  **State Update:** The baseline ID for the chat is continuously updated to the latest processed message ID to prevent reprocessing.

## Troubleshooting

- **Permission Denied / Error Reading Database:**
  - Ensure your terminal application has **Full Disk Access** in `System Settings > Privacy & Security`.
  - **Restart your terminal application** after granting permissions.
  - Verify the `DB_PATH` in `.env` is correct (use the full path like `/Users/your_username/Library/Messages/chat.db`).
- **AppleScript Errors (e.g., -1728, -10002, "Can't get buddy/chat", "Invalid key form"):**
  - Ensure your terminal application has **Automation** permission for `Messages.app` in `System Settings > Privacy & Security`. Toggle it off and on if needed.
  - **Restart your terminal application** after changing permissions.
  - **Restart the Messages app.**
  - **Restart your Mac.** This often resolves temporary AppleScript communication issues.
  - Verify the `TARGET_CHAT_IDENTIFIERS` in `.env` are correct (plain phone numbers/emails usually work best with the current `buddy` script).
- **LLM Errors (API Error, No content):**
  - Double-check `OPENAI_API_KEY`, `OPENAI_API_ENDPOINT`, and `LLM_MODEL` in your `.env` file.
  - Ensure your API key is valid and has credits/quota.
  - Check your internet connection.
- **Bot Not Responding:**
  - Check the terminal logs for errors.
  - Verify `TARGET_CHAT_IDENTIFIERS` in `.env` is correct and includes the chat you're testing.
  - Ensure you are sending _iMessages_ (blue bubbles) to the bot, not SMS (green bubbles).
  - Confirm the script was running _before_ the new message arrived (it ignores messages present at startup).
  - Check the `POLL_INTERVAL_MS` - maybe it just hasn't checked yet.
- **Incorrect Chat Identifier:** Use the list printed at startup (`Identifying Recent Chats`) to find the correct identifier string for your target conversation(s) and update `TARGET_CHAT_IDENTIFIERS` in `.env`. Remember it's comma-separated with no extra spaces.
