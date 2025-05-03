import { Database } from "bun:sqlite";
import { $ } from "bun";
import { config } from "dotenv";
import os from "os";

// Load environment variables from .env file
config();

// --- Configuration ---
const dbPath = process.env.DB_PATH?.replace("~", os.homedir());
// Read the comma-separated list of identifiers
const targetIdentifiersString = process.env.TARGET_CHAT_IDENTIFIERS || "";
// Split the string into an array and trim whitespace from each identifier
const targetIdentifiers = targetIdentifiersString
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id !== ""); // Remove empty strings if user adds extra commas

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
if (targetIdentifiers.length === 0) {
  console.error(
    "Error: No target identifiers found in TARGET_CHAT_IDENTIFIERS environment variable. Please provide a comma-separated list.",
  );
  process.exit(1);
}

// --- State ---
// Use a Map to store the last processed message ID *for each* chat identifier
let lastProcessedMessageIds: Map<string, number> = new Map();
// Global lock might still be useful to prevent the whole check cycle from overlapping if it takes longer than the interval
let isProcessingCycle = false;

// --- SQLite Database Connection ---
let db: Database;

// --- Types ---
// (Keep Message, LLMMessage, RecentChatInfo interfaces as they were)
interface Message {
  rowid: number;
  text: string | null;
  is_from_me: number;
  date: number;
  service?: string;
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
  // ... (Keep this function exactly as it was) ...
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
        "Last 5 active chats (add desired 'Identifiers' to TARGET_CHAT_IDENTIFIERS in .env):", // Updated help text
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
 * Fetches the most recent iMessages (only) from the specified chat identifier.
 */
function fetchMessages(chatId: string, limit: number): Message[] {
  // ... (Keep this function exactly as it was, using chatId parameter) ...
  try {
    const query = db.query<Message, [string, number]>(`
            SELECT
                m.ROWID as rowid,
                m.text,
                m.is_from_me,
                m.date,
                m.service
            FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            JOIN chat c ON cmj.chat_id = c.ROWID
            WHERE
                c.chat_identifier = ?
                AND m.service = 'iMessage'
            ORDER BY m.date DESC
            LIMIT ?;
        `);
    const messages = query.all(chatId, limit);
    return messages.reverse();
  } catch (error) {
    console.error(`Error fetching iMessages for ${chatId}:`, error); // Log identifier on error
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
  // ... (Keep this function exactly as it was, using recipientIdentifier parameter) ...
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
      `Message sent successfully via AppleScript to ${recipientIdentifier}.`, // Log identifier on success
    );
  } catch (error) {
    console.error(
      `Error sending message via AppleScript to ${recipientIdentifier}:`, // Log identifier on error
      error,
    );
    console.error(
      "Ensure Messages app is running, Automation permissions are granted, and the identifier is a valid iMessage contact.",
    );
  }
}

/**
 * Queries the configured OpenAI-compatible LLM API.
 */
async function queryLLM(
  messages: LLMMessage[],
  chatIdentifier: string,
): Promise<string | null> {
  // Added chatIdentifier for logging
  console.log(
    `Querying LLM for chat ${chatIdentifier}: ${openaiApiEndpoint} with model ${llmModel}`,
  );
  try {
    // ... (Keep fetch logic the same) ...
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
        `LLM API Error for ${chatIdentifier}: ${response.status} ${response.statusText}`, // Log identifier on error
        errorBody,
      );
      return null;
    }
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error(
        `LLM API Error for ${chatIdentifier}: No content in response structure`,
        data,
      ); // Log identifier on error
      return null;
    }
    console.log(`LLM Response received for ${chatIdentifier}.`); // Log identifier on success
    return reply;
  } catch (error) {
    console.error(`Error calling LLM API for ${chatIdentifier}:`, error); // Log identifier on error
    return null;
  }
}

/**
 * Initializes the last processed message ID for all configured target identifiers.
 */
function initializeAllLastMessageIds() {
  console.log("Initializing message tracking for all target identifiers...");
  let initializedCount = 0;
  for (const identifier of targetIdentifiers) {
    // console.log(`Initializing for ${identifier}...`); // Optional verbose log
    try {
      const query = db.query<{ rowid: number }, [string]>(`
                SELECT m.ROWID as rowid
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                WHERE
                    c.chat_identifier = ?
                    AND m.service = 'iMessage'
                ORDER BY m.date DESC
                LIMIT 1;
            `);
      const latestMsg = query.get(identifier);

      if (latestMsg) {
        lastProcessedMessageIds.set(identifier, latestMsg.rowid);
        // console.log(`  -> Initialized ${identifier}. Will ignore messages up to ID: ${latestMsg.rowid}.`); // Optional verbose log
        initializedCount++;
      } else {
        lastProcessedMessageIds.set(identifier, 0); // Start from 0 if no history
        // console.log(`  -> No existing iMessages found for ${identifier}. Will process first incoming.`); // Optional verbose log
        initializedCount++;
      }
    } catch (error) {
      console.error(
        `Error initializing last iMessage ID for ${identifier}:`,
        error,
      );
      // Keep map entry undefined/null or set to 0? Let's set to 0 to allow processing.
      lastProcessedMessageIds.set(identifier, 0);
      console.error(
        `  -> Will attempt to process messages from beginning for ${identifier}.`,
      );
    }
  }
  console.log(
    `Initialization complete. Tracking ${initializedCount} out of ${targetIdentifiers.length} identifiers.`,
  );
  if (initializedCount < targetIdentifiers.length) {
    console.warn(
      "Warning: Some identifiers failed initialization. Check errors above.",
    );
  }
}

/**
 * Core function: Checks all configured chats for new incoming iMessages and triggers responses.
 */
async function checkAndRespondAllChats() {
  // Prevent the entire cycle from overlapping if it takes too long
  if (isProcessingCycle) {
    // console.log("Previous check cycle still running, skipping."); // Optional log
    return;
  }
  isProcessingCycle = true;
  // console.log("Starting check cycle for all chats..."); // Optional log

  try {
    // Process each configured identifier sequentially
    for (const identifier of targetIdentifiers) {
      const lastId = lastProcessedMessageIds.get(identifier);

      // Skip if initialization failed for this ID (or if set to undefined somehow)
      if (lastId === undefined) {
        // console.warn(`Skipping check for ${identifier}: Not initialized.`); // Optional log
        continue;
      }

      // --- Logic for a single chat, adapted from previous checkAndRespond ---
      try {
        const recentMessages = fetchMessages(identifier, messageContextLimit);
        if (recentMessages.length === 0) continue; // Skip if no messages for this chat

        let newIncomingMessage: Message | null = null;
        let latestMessageIdInBatch = lastId; // Start with the last known ID

        for (let i = recentMessages.length - 1; i >= 0; i--) {
          const msg = recentMessages[i];
          if (msg.rowid > latestMessageIdInBatch) {
            latestMessageIdInBatch = msg.rowid;
          }
          if (msg.is_from_me === 0 && msg.rowid > lastId) {
            if (
              newIncomingMessage === null ||
              msg.rowid > newIncomingMessage.rowid
            ) {
              newIncomingMessage = msg;
            }
          }
        }

        if (newIncomingMessage) {
          console.log(
            `[${identifier}] New iMessage detected (ID: ${newIncomingMessage.rowid}, since startup ID: ${lastId}): "${newIncomingMessage.text}"`,
          );
          // Update the specific ID for this chat in the map
          lastProcessedMessageIds.set(identifier, newIncomingMessage.rowid);

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

          const reply = await queryLLM(llmContext, identifier); // Pass identifier for logging

          if (reply) {
            await sendIMessage(identifier, reply);
          } else {
            console.log(`[${identifier}] LLM did not provide a reply.`);
          }
        } else {
          // Update if newer messages (even outgoing) were seen in the batch
          if (latestMessageIdInBatch > lastId) {
            // console.log(`[${identifier}] Updating last processed ID to ${latestMessageIdInBatch} (no new incoming).`); // Optional log
            lastProcessedMessageIds.set(identifier, latestMessageIdInBatch);
          }
        }
      } catch (error) {
        console.error(`Error processing chat ${identifier}:`, error);
        // Continue to the next identifier even if one fails
      }
      // --- End of logic for a single chat ---
    } // End loop through identifiers
  } catch (outerError) {
    // Catch errors in the main loop setup (less likely)
    console.error(
      "Error during the main checkAndRespondAllChats loop:",
      outerError,
    );
  } finally {
    // Release the lock for the entire cycle
    isProcessingCycle = false;
    // console.log("Finished check cycle."); // Optional log
  }
}

// --- Main Execution ---
try {
  console.log(`Attempting to connect to SQLite DB at: ${dbPath}`);
  db = new Database(dbPath, { readonly: true });
  console.log("Successfully connected to SQLite DB.");

  displayRecentChats(); // Show recent chats to help user

  // Initialize last message IDs for all configured targets
  initializeAllLastMessageIds();
} catch (error) {
  console.error(`Error connecting to SQLite DB at ${dbPath}:`, error);
  console.error("Please ensure the path is correct and Bun has permissions.");
  process.exit(1);
}

console.log(`Monitoring ${targetIdentifiers.length} chat identifier(s):`);
targetIdentifiers.forEach((id, index) => console.log(`  ${index + 1}. ${id}`));
console.log("Starting iMessage Chatbot Server...");

// Start the polling interval for checking all chats
setInterval(checkAndRespondAllChats, pollIntervalMs);

// Basic HTTP server
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      // Generate status string showing monitored IDs
      const monitoredIds = Array.from(lastProcessedMessageIds.entries())
        .map(([id, lastMsgId]) => `${id} (since ID ${lastMsgId})`)
        .join(", ");
      const status =
        targetIdentifiers.length > 0
          ? `Monitoring ${targetIdentifiers.length} chat(s): ${monitoredIds || "Initializing..."}`
          : "Paused. No target identifiers configured or initialized.";
      return new Response(`iMessage Chatbot running. ${status}`, {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Bun server listening on http://localhost:${server.port}`);
console.log(`Polling interval: ${pollIntervalMs / 1000} seconds`);

// Graceful shutdown handler
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  if (db) {
    db.close();
    console.log("Database connection closed.");
  }
  server.stop(true);
  console.log("Server stopped.");
  process.exit(0);
});

