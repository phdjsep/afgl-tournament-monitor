const https = require('https');
const http = require('http');
const fs = require('fs');
const { parse } = require('node-html-parser');

const TARGET_URL = process.env.TARGET_URL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TOURNAMENT_COUNT_FILE = 'tournament_count.txt';
const TOURNAMENTS_FILE = 'tournaments.json';

// Sleep utility for retry logic
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to fetch webpage content
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    console.log(`Attempting to fetch: ${url}`);
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, (res) => {
      console.log(`HTTP Status: ${res.statusCode}`);

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Page fetch completed. Content length: ${data.length}`);
        resolve(data);
      });
    });

    request.on('error', (error) => {
      console.error('HTTP request error:', error);
      reject(error);
    });

    // Set a timeout
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Request timeout after 30 seconds'));
    });
  });
}

// Function to fetch page with retry logic
async function fetchPageWithRetry(url, maxRetries = 3) {
  console.log('::group::Fetching tournament page');
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fetchPage(url);
      console.log('::endgroup::');
      return result;
    } catch (error) {
      console.error(`Attempt ${i + 1}/${maxRetries} failed:`, error.message);
      if (i === maxRetries - 1) {
        console.log('::endgroup::');
        throw error;
      }
      const waitTime = 1000 * Math.pow(2, i);
      console.log(`Waiting ${waitTime}ms before retry...`);
      await sleep(waitTime);
    }
  }
}

// Function to extract tournament details from HTML
function extractTournaments(html) {
  try {
    console.log('::group::Extracting tournament details from HTML');

    const root = parse(html);
    const tournamentRows = root.querySelectorAll('tr.vevent');

    console.log(`Found ${tournamentRows.length} tournament rows`);

    const tournaments = [];

    tournamentRows.forEach((row, index) => {
      try {
        // Extract unique key - use data-shortname from td.tinfo or row id
        const tinfoCell = row.querySelector('td.tinfo');
        const key = (tinfoCell && tinfoCell.getAttribute('data-shortname')) ||
                    row.getAttribute('id') ||
                    `tournament-${index}`;

        // Extract tournament name from span.summary a
        const nameLink = row.querySelector('td.tinfo span.summary a');
        const name = nameLink ? nameLink.text.trim() : '';

        // Extract date from td.dtstart > span (first span only)
        const dateCell = row.querySelector('td.dtstart span');
        const date = dateCell ? dateCell.text.trim() : '';

        // Extract location from the address link
        const locationLink = row.querySelector('td.tinfo a.address');
        const location = locationLink ? locationLink.text.trim() : '';

        // Only add if we have at least a name
        if (name) {
          const tournament = {
            key: key,
            name: name,
            date: date,
            location: location
          };

          tournaments.push(tournament);
          console.log(`  Tournament ${index + 1}: ${name} - ${date} - ${location}`);
        } else {
          console.log(`  Skipping row ${index + 1}: No name found`);
        }
      } catch (rowError) {
        console.error(`  Error processing row ${index + 1}:`, rowError.message);
      }
    });

    console.log(`Successfully extracted ${tournaments.length} tournaments`);
    console.log('::endgroup::');
    return tournaments;

  } catch (error) {
    console.error('Error in extractTournaments:', error);
    console.error('Stack trace:', error.stack);
    console.log('::endgroup::');
    return [];
  }
}

// Function to send Discord notification
function sendDiscordNotification(message) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK_URL);

    // Fix: Escape backslashes first, then quotes
    const cleanMessage = message
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .substring(0, 2000); // Use full Discord limit

    const payload = JSON.stringify({
      content: cleanMessage,
      username: 'AFGL Tournament Monitor'
    });

    console.log(`Payload length: ${payload.length}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8')
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log(`Discord response status: ${res.statusCode}`);
        if (res.statusCode !== 204 && res.statusCode !== 200) {
          console.log(`Discord response: ${responseData}`);
        } else {
          console.log('Discord notification sent successfully!');
        }
        resolve(res.statusCode);
      });
    });

    req.on('error', (error) => {
      console.error('Discord webhook error:', error);
      reject(error);
    });

    // Add timeout for Discord webhook
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Discord webhook timeout after 10 seconds'));
    });

    req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    console.log(`Checking AFGL tournament schedule at: ${TARGET_URL}`);

    // Validate environment variables early
    if (!TARGET_URL) {
      throw new Error('TARGET_URL environment variable not set');
    }
    if (!DISCORD_WEBHOOK_URL) {
      throw new Error('DISCORD_WEBHOOK_URL environment variable not set');
    }

    // Validate Discord webhook URL format
    if (!DISCORD_WEBHOOK_URL.startsWith('https://discord.com/api/webhooks/') &&
        !DISCORD_WEBHOOK_URL.startsWith('https://discordapp.com/api/webhooks/')) {
      throw new Error('Invalid DISCORD_WEBHOOK_URL format - must be a Discord webhook URL');
    }

    // Fetch current page content with retry
    console.log('Fetching page content...');
    const rawContent = await fetchPageWithRetry(TARGET_URL);

    if (!rawContent || rawContent.length < 100) {
      throw new Error(`Page content seems invalid. Length: ${rawContent ? rawContent.length : 0}`);
    }

    console.log(`Page fetched successfully. Content length: ${rawContent.length} characters`);

    // Extract current tournaments
    const currentTournaments = extractTournaments(rawContent);
    console.log(`Current tournament count: ${currentTournaments.length}`);

    // Load previous tournaments
    let previousTournaments = [];

    if (fs.existsSync(TOURNAMENTS_FILE)) {
      try {
        const fileContent = fs.readFileSync(TOURNAMENTS_FILE, 'utf8');
        const data = JSON.parse(fileContent);
        previousTournaments = data.tournaments || [];
        console.log(`Previous tournament count: ${previousTournaments.length}`);
        console.log(`Last checked: ${data.lastChecked}`);
      } catch (error) {
        console.log('Could not read previous tournaments file:', error.message);
        console.log('Treating as first run');
      }
    } else {
      console.log('No previous tournaments file found - treating as first run');
    }

    // Find new tournaments by comparing keys
    const previousKeys = new Set(previousTournaments.map(t => t.key));
    const newTournaments = currentTournaments.filter(t => !previousKeys.has(t.key));

    console.log(`Found ${newTournaments.length} new tournament(s)`);

    // Compare and notify
    if (previousTournaments.length === 0 && currentTournaments.length > 0) {
      // First run with tournaments found - establish baseline
      console.log('First run with tournaments detected - establishing baseline');
      const message = `✅ **AFGL Tournament Monitor Active**\n\n` +
                    `Now monitoring: ${TARGET_URL}\n\n` +
                    `Baseline tournament count: ${currentTournaments.length}\n\n` +
                    `You'll be notified when new tournaments are added to the schedule.`;

      console.log('Sending baseline establishment notification...');
      await sendDiscordNotification(message);

    } else if (newTournaments.length > 0) {
      // New tournaments detected
      console.log(`🏆 ${newTournaments.length} new tournament(s) detected!`);

      // Build message with tournament details
      let message = `🏆 **${newTournaments.length} New Tournament(s) Added!**\n\n`;

      newTournaments.forEach(tournament => {
        message += `📅 **${tournament.name}**\n`;
        if (tournament.date && tournament.location) {
          message += `${tournament.date} • ${tournament.location}\n\n`;
        } else if (tournament.date) {
          message += `${tournament.date}\n\n`;
        } else if (tournament.location) {
          message += `${tournament.location}\n\n`;
        } else {
          message += `\n`;
        }
      });

      message += `<${TARGET_URL}>`;

      console.log('Sending Discord notification for new tournaments...');
      await sendDiscordNotification(message);
      console.log('Discord notification sent for new tournaments!');

    } else if (previousTournaments.length === 0 && currentTournaments.length === 0) {
      // Both current and previous are 0 - something might be wrong with detection
      console.log('Warning: No tournaments detected in current or previous runs');
      console.log('This might indicate an issue with the tournament detection logic');
      // Don't send notification to avoid spam

    } else if (currentTournaments.length < previousTournaments.length) {
      console.log(`Note: Tournament count decreased from ${previousTournaments.length} to ${currentTournaments.length}`);
      // Could be tournaments removed or date filtering

    } else {
      console.log('No new tournaments detected');
    }

    // Save current tournaments with error handling
    console.log(`Saving tournament data: ${currentTournaments.length} tournaments`);
    try {
      const data = {
        lastChecked: new Date().toISOString(),
        tournaments: currentTournaments
      };
      fs.writeFileSync(TOURNAMENTS_FILE, JSON.stringify(data, null, 2));
      console.log('Tournament data saved successfully');

      // Also save count for backward compatibility
      fs.writeFileSync(TOURNAMENT_COUNT_FILE, currentTournaments.length.toString());
      console.log('Tournament count saved successfully');
    } catch (error) {
      console.error('Failed to write tournament files:', error);
      throw new Error(`Failed to save tournament data: ${error.message}`);
    }

  } catch (error) {
    console.error('Error in main function:', error);
    console.error('Stack trace:', error.stack);

    try {
      const errorMessage = `❌ **AFGL Monitor Error**\n\nFailed to check tournament schedule:\n\`\`\`\n${error.message}\n\`\`\``;
      await sendDiscordNotification(errorMessage);
    } catch (notificationError) {
      console.error('Failed to send error notification:', notificationError);
    }

    // Re-throw to ensure GitHub Action fails
    process.exit(1);
  }
}

main();
