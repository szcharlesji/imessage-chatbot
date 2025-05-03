import { Database } from "bun:sqlite";
import { $ } from "bun";
import { config } from "dotenv";
import os from "os";

// Load environment variables from .env file
config();

// --- Configuration ---
const dbPath = process.env.DB_PATH?.replace("~", os.homedir());
const targetChatIdentifier = process.env.TARGET_CHAT_IDENTIFIER;
const openaiApiEndpoint = process.env.OPENAI_API_ENDPOINT;
const openaiApiKey = process.env.OPENAI_API_KEY;
const llmModel = process.env.LLM_MODEL || "gpt-4";
const systemPrompt = process.env.SYSTEM_PROMPT || "You are a helpful chatbot.";
const messageContextLimit = parseInt(
  process.env.MESSAGE_CONTEXT_LIMIT || "10",
  10,
);
const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const botName = process.env.BOT_NAME || "Me";
const otherUserName = process.env.OTHER_USER_NAME || "Them";

// --- Basic Validation ---
if (!dbPath || !openaiApiEndpoint || !openaiApiKey) {
  console.error(
    "Error: Missing required environment variables (DB_PATH, OPENAI_API_ENDPOINT, OPENAI_API_KEY)",
  );
  process.exit(1);
}

// --- State ---
let lastProcessedMessageId: number | null = null; // Will be initialized at startup
let isProcessing = false;

// --- SQLite Database Connection ---
let db: Database;

// --- Types ---
interface Message {
  rowid: number;
  text: string | null;
  is_from_me: number;
  date: number;
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RecentChatInfo {
  chat_identifier: string;
  display_name: string | null;
  last_message_date: number;
}

// --- Helper Functions ---

/**
 * Displays the 5 most recently active chats and their identifiers at startup.
 */
function displayRecentChats() {
  // ... (keep this function exactly as it was)
  console.log("\n--- Identifying Recent Chats ---");
  if (!db) {
    console.log("Database connection not available for recent chat lookup.");
    return;
  }
  try {
    const query = db.query<RecentChatInfo, []>(`
            SELECT
                c.chat_identifier,
                c.display_name,
                MAX(m.date) as last_message_date
            FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            JOIN chat c ON cmj.chat_id = c.ROWID
            WHERE c.chat_identifier IS NOT NULL AND c.chat_identifier != ''
            GROUP BY c.ROWID
            ORDER BY last_message_date DESC
            LIMIT 5;
        `);
    const recentChats = query.all();

    if (recentChats.length > 0) {
      console.log(
        "Last 5 active chats (use the 'Identifier' in your .env file for TARGET_CHAT_IDENTIFIER):",
      );
      recentChats.forEach((chat, index) => {
        const name = chat.display_name
          ? `"${chat.display_name}"`
          : "(No display name / Direct chat)";
        console.log(
          `${index + 1}. ${name} -> Identifier: ${chat.chat_identifier}`,
        );
      });
    } else {
      console.log("Could not retrieve recent chat information.");
    }
  } catch (error) {
    console.error("Error fetching recent chats:", error);
  }
  console.log("--------------------------------\n");
}

/**
 * Fetches the most recent messages from the specified chat identifier.
 */
function fetchMessages(chatId: string, limit: number): Message[] {
  // ... (keep this function exactly as it was)
  try {
    const query = db.query<Message, [string, number]>(`
            SELECT
                m.ROWID as rowid,
                m.text,
                m.is_from_me,
                m.date
            FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            JOIN chat c ON cmj.chat_id = c.ROWID
            WHERE c.chat_identifier = ?
            ORDER BY m.date DESC
            LIMIT ?;
        `);
    const messages = query.all(chatId, limit);
    return messages.reverse(); // Return in chronological order
  } catch (error) {
    console.error("Error fetching messages from database:", error);
    return [];
  }
}

/**
 * Sends an iMessage using AppleScript via the 'buddy' command and specific service.
 */
async function sendIMessage(
  recipientIdentifier: string,
  messageText: string,
): Promise<void> {
  // ... (keep this function exactly as it was)
  console.log(
    `Sending message to buddy ${recipientIdentifier} via iMessage service 1: "${messageText}"`,
  );
  const escapedMessage = messageText
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const appleScript = `
        tell application "Messages"
            set targetBuddy to buddy "${recipientIdentifier}" of (service 1 whose service type is iMessage)
            send "${escapedMessage}" to targetBuddy
        end tell
    `;
  try {
    await $`osascript -e ${appleScript}`.quiet();
    console.log(
      "Message sent successfully via AppleScript (using buddy and service 1).",
    );
  } catch (error) {
    console.error(
      "Error sending message via AppleScript (using buddy and service 1):",
      error,
    );
    console.error(
      "Ensure Messages app is running, Automation permissions are granted (e.g., Terminal/Ghostty -> Messages), and the identifier is a valid iMessage contact (phone/email).",
    );
  }
}

/**
 * Queries the configured OpenAI-compatible LLM API.
 */
async function queryLLM(messages: LLMMessage[]): Promise<string | null> {
  // ... (keep this function exactly as it was)
  console.log(`Querying LLM: ${openaiApiEndpoint} with model ${llmModel}`);
  try {
    const response = await fetch(openaiApiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: llmModel,
        messages: messages,
        temperature: 0.7,
        max_tokens: 150,
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `LLM API Error: ${response.status} ${response.statusText}`,
        errorBody,
      );
      return null;
    }
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error("LLM API Error: No content in response structure", data);
      return null;
    }
    console.log("LLM Response received.");
    return reply;
  } catch (error) {
    console.error("Error calling LLM API:", error);
    return null;
  }
}

/**
 * Core function: Checks for new incoming messages (since script start) and triggers response.
 */
async function checkAndRespond() {
  // Skip if target not set OR if lastProcessedMessageId hasn't been initialized yet
  if (!targetChatIdentifier || lastProcessedMessageId === null) {
    return;
  }

  // Prevent overlapping execution cycles
  if (isProcessing) {
    return;
  }
  isProcessing = true;
  // console.log("Checking for new messages..."); // Optional: uncomment for verbose polling log

  try {
    // Fetch recent messages for context, ensure limit is reasonable
    const recentMessages = fetchMessages(
      targetChatIdentifier,
      messageContextLimit,
    );

    // If no messages found (unlikely after init), skip
    if (recentMessages.length === 0) {
      isProcessing = false;
      return;
    }

    // Find the latest *incoming* message that is newer than the last one processed *at startup*
    let newIncomingMessage: Message | null = null;
    let latestMessageIdInBatch = 0; // Track the latest ID seen in this batch

    // Iterate backwards from the newest message in the fetched batch
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      if (msg.rowid > latestMessageIdInBatch) {
        latestMessageIdInBatch = msg.rowid; // Update latest seen ID
      }
      // Check if it's from the other person AND its ID is strictly greater than the ID recorded at startup
      if (msg.is_from_me === 0 && msg.rowid > lastProcessedMessageId) {
        // If we haven't found a newer incoming message yet OR this one is newer than the one found
        if (
          newIncomingMessage === null ||
          msg.rowid > newIncomingMessage.rowid
        ) {
          newIncomingMessage = msg;
          // Don't break here, we want the absolute latest incoming message in the batch
        }
      }
    }

    // If a new incoming message (since startup) was found, process it
    if (newIncomingMessage) {
      console.log(
        `New incoming message detected (ID: ${newIncomingMessage.rowid}, since startup ID: ${lastProcessedMessageId}): "${newIncomingMessage.text}"`,
      );
      // IMPORTANT: Update lastProcessedMessageId to the ID of the message we are *responding* to.
      // This prevents responding to the same message again if multiple arrive between polls.
      lastProcessedMessageId = newIncomingMessage.rowid;

      // Build the context for the LLM (using the fetched recent messages)
      const llmContext: LLMMessage[] = [
        { role: "system", content: systemPrompt },
      ];
      recentMessages.forEach((msg) => {
        if (msg.text && msg.text.trim() !== "" && !msg.text.includes("￼")) {
          llmContext.push({
            role: msg.is_from_me ? "assistant" : "user",
            content: `${msg.is_from_me ? botName : otherUserName}: ${msg.text}`,
          });
        }
      });
      llmContext.push({
        role: "user",
        content: `Based on the conversation above, what should ${botName} say next? Respond with only the message content.`,
      });

      // Get the response from the LLM
      const reply = await queryLLM(llmContext);

      // If the LLM provided a valid reply, send it as an iMessage
      if (reply) {
        await sendIMessage(targetChatIdentifier, reply);
      } else {
        console.log("LLM did not provide a reply.");
      }
    } else {
      // If no new *incoming* message was found, BUT there were messages in the batch newer than
      // our lastProcessedMessageId (e.g., outgoing messages), update lastProcessedMessageId
      // to prevent reprocessing old incoming messages if the script restarts.
      if (latestMessageIdInBatch > lastProcessedMessageId) {
        // console.log(`Updating lastProcessedMessageId to ${latestMessageIdInBatch} to track latest message.`); // Optional log
        lastProcessedMessageId = latestMessageIdInBatch;
      }
      // console.log("No new incoming messages since last check."); // Optional log
    }
  } catch (error) {
    console.error("Error during checkAndRespond cycle:", error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Initializes the lastProcessedMessageId by finding the latest message ID at startup.
 */
function initializeLastMessageId() {
  if (!targetChatIdentifier) {
    console.log(
      "Cannot initialize last message ID: TARGET_CHAT_IDENTIFIER not set.",
    );
    return;
  }
  console.log(`Initializing message tracking for ${targetChatIdentifier}...`);
  try {
    // Query to get only the ROWID of the single most recent message in the chat
    const query = db.query<{ rowid: number }, [string]>(`
            SELECT m.ROWID as rowid
            FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            JOIN chat c ON cmj.chat_id = c.ROWID
            WHERE c.chat_identifier = ?
            ORDER BY m.date DESC
            LIMIT 1;
        `);
    const latestMsg = query.get(targetChatIdentifier); // Use .get() for single result

    if (latestMsg) {
      lastProcessedMessageId = latestMsg.rowid;
      console.log(
        `Initialization complete. Will only process messages newer than ID: ${lastProcessedMessageId}.`,
      );
    } else {
      // If there are absolutely no messages in the chat history
      lastProcessedMessageId = 0; // Start from beginning (or handle as needed)
      console.log(
        `No existing messages found for ${targetChatIdentifier}. Will process first incoming message.`,
      );
    }
  } catch (error) {
    console.error("Error initializing last message ID:", error);
    // Decide if you want to exit or try to continue without initialization
    // For now, we'll allow it to continue, but polling won't work until initialized.
    lastProcessedMessageId = null;
    console.error(
      "Polling will be paused until initialization succeeds on next attempt (if applicable).",
    );
  }
}

// --- Main Execution ---

try {
  console.log(`Attempting to connect to SQLite DB at: ${dbPath}`);
  db = new Database(dbPath, { readonly: true });
  console.log("Successfully connected to SQLite DB.");

  // Display recent chats first
  displayRecentChats();

  // *** Initialize the last message ID BEFORE starting the interval ***
  initializeLastMessageId();
} catch (error) {
  console.error(`Error connecting to SQLite DB at ${dbPath}:`, error);
  console.error(
    "Please ensure the path is correct and Bun has permissions (e.g., Full Disk Access for Terminal/Ghostty).",
  );
  process.exit(1);
}

// Check if the target identifier is set (it should be for initialization to work)
if (!targetChatIdentifier) {
  console.warn("Warning: TARGET_CHAT_IDENTIFIER is not set in your .env file.");
  console.warn("Please add the correct identifier and restart the script.");
} else if (lastProcessedMessageId === null) {
  console.warn(
    "Warning: Failed to initialize last message ID. Polling may not function correctly.",
  );
}

console.log("Starting iMessage Chatbot Server...");

// Set interval; checkAndRespond will now use the initialized lastProcessedMessageId
setInterval(checkAndRespond, pollIntervalMs);

// Basic HTTP server
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      const status =
        targetChatIdentifier && lastProcessedMessageId !== null
          ? `Monitoring chat: ${targetChatIdentifier}. Ignoring messages up to ID: ${lastProcessedMessageId}`
          : "Paused or not initialized.";
      return new Response(`iMessage Chatbot running. ${status}`, {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Bun server listening on http://localhost:${server.port}`);
if (targetChatIdentifier && lastProcessedMessageId !== null) {
  console.log(`Polling interval: ${pollIntervalMs / 1000} seconds`);
}

// Graceful shutdown handler
process.on("SIGINT", () => {
  // ... (keep shutdown handler as it was)
  console.log("\nShutting down...");
  if (db) {
    db.close();
    console.log("Database connection closed.");
  }
  server.stop(true);
  console.log("Server stopped.");
  process.exit(0);
});

