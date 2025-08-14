# Brainpipe

A Raycast extension that automatically extracts actionable to-dos from your markdown "brain dump" files and syncs them to Notion. Runs hourly in the background to keep your task list up-to-date without manual intervention.

## How It Works

Brainpipe operates on a simple but powerful workflow:

1. **Hourly Background Scan**: Automatically scans your designated brain dump directory for modified markdown files
2. **Smart Task Extraction**: Uses OpenAI's API to intelligently identify actionable tasks from various markdown formats
3. **Duplicate Prevention**: Maintains a local state to ensure tasks aren't created multiple times
4. **Notion Integration**: Creates tasks in your Notion database with proper formatting and metadata

The hourly sync runs silently in the background using Raycast's scheduled refresh mechanism. You can also trigger manual syncs on-demand.

## Features

- ✅ **Automatic hourly background sync** (can be enabled/disabled)
- ✅ **Manual "Run Now" command** for immediate syncing
- ✅ **Smart task extraction** from multiple markdown formats:
  - `- [ ] Buy milk`
  - `TODO: call John`
  - `* follow up with Sarah`
  - Action items with due dates: `due:16/08`, `due:2025-08-20`
- ✅ **Duplicate prevention** using content-based hashing
- ✅ **File change detection** (only processes modified files)
- ✅ **Large file support** with intelligent chunking
- ✅ **Robust error handling** with retry logic for API failures
- ✅ **Comprehensive logging** (Raycast console + rotating log files)
- ✅ **Date normalisation** (British DD/MM format → YYYY-MM-DD)

## Installation & Setup

### 1. Install the Extension

```bash
# Clone or download the extension to your Raycast extensions directory
git clone <this-repo> ~/raycast-extensions/brainpipe
cd ~/raycast-extensions/brainpipe

# Install dependencies
npm install

# Build the extension
npm run build
```

### 2. Load in Raycast

1. Open Raycast
2. Search for "Import Extension" 
3. Navigate to the `~/raycast-extensions/brainpipe` directory
4. Import the extension

### 3. Configure Preferences

Open Raycast preferences and navigate to the Brainpipe extension. Configure the following:

#### Required Settings:

- **Brain Dump Directory**: Path to your markdown files (default: `~/BrainDump/inbox`)
- **OpenAI API Key**: Your OpenAI API key for task extraction
- **OpenAI Model**: Model to use (default: `gpt-4o`)
- **Notion Integration Token**: Your Notion integration token  
- **Notion Database ID**: ID of your Notion database

#### Optional Settings:

- **Enable Hourly Background Sync**: Toggle automatic hourly syncing (default: enabled)

### 4. Set Up Your Notion Database

Create a Notion database with these exact column names and types:

| Column Name | Type | Description |
|-------------|------|-------------|
| `Name` | Title | Task title |
| `Status` | Select | Task status (create "Inbox" option) |
| `Due Date` | Date | Optional due date |
| `Tags` | Multi-select | Optional tags |
| `Task ID` | Rich Text | Unique task identifier (for deduplication) |
| `Source` | Rich Text | Source file and line number |

**Important**: Column names must match exactly, including capitalisation.

### 5. Get Your API Keys

#### OpenAI API Key:
1. Visit [OpenAI API Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Navigate to API Keys
4. Generate a new secret key
5. Copy the key (starts with `sk-`)

#### Notion Integration Token:
1. Visit [Notion Integrations](https://www.notion.so/my-integrations)
2. Create a new integration
3. Copy the "Internal Integration Token" (starts with `secret_`)
4. Share your database with the integration:
   - Open your Notion database
   - Click "Share" → "Add people, emails, groups, or integrations"
   - Search for your integration name and add it

#### Notion Database ID:
1. Open your database in Notion
2. Copy the URL - it looks like: `https://notion.so/workspace/DATABASE_ID?v=VIEW_ID`
3. Extract the `DATABASE_ID` part (32 characters, alphanumeric with dashes)

## Usage

### Manual Sync
- Open Raycast
- Search for "Extract & Sync (Run Now)"  
- Press Enter to trigger immediate sync
- View progress notifications and results

### Automatic Sync
- Runs automatically every hour when enabled
- No user interface - operates silently
- Check logs for sync status and results

### Supported Task Formats

Brainpipe recognises these task patterns:

```markdown
# Checkbox tasks
- [ ] Buy groceries
- [ ] Send email to client due:16/08
- [ ] Review PR #123

# TODO items  
TODO: Call dentist for appointment
TODO: Update documentation due:2025-08-20

# Action items
* follow up with Sarah about proposal
* book meeting room for next week due:18/8

# With tags (extracted automatically)
- [ ] Plan team meeting #work #urgent
- [ ] Buy birthday gift #personal #shopping
```

### Date Format Support

Brainpipe handles various date formats:

- `due:2025-08-16` → `2025-08-16` (ISO format)
- `due:16/08` → `2025-08-16` (British format, assumes current year) 
- `due:16/8` → `2025-08-16` (British format, single digit month)

## Test Drive

### Quick Test Setup

1. Create a test brain dump file:
```bash
mkdir -p ~/BrainDump/inbox
cat > ~/BrainDump/inbox/test-$(date +%Y-%m-%d).md << 'EOF'
# Meeting Notes

## Action Items
- [ ] Follow up with Alice about project timeline due:16/08
- [ ] Review budget proposal #finance #urgent  
- [ ] Book conference room for next team meeting

TODO: Update project documentation
TODO: Send weekly report to stakeholders due:2025-08-20

## Completed
- [x] Sent meeting invite (this should be ignored)

Regular meeting notes that shouldn't be extracted as tasks.
EOF
```

2. Configure all preferences in Raycast

3. Run manual sync: Search "Extract & Sync (Run Now)" in Raycast

4. Check your Notion database - you should see new tasks with:
   - Proper titles
   - "Inbox" status
   - Correct due dates
   - Extracted tags
   - Source information

## Troubleshooting

### Configuration Issues

**Error: "OpenAI API key not configured"**
- Ensure your API key is entered in Raycast preferences
- Verify the key starts with `sk-`
- Check your OpenAI account has available credits

**Error: "Notion database ID not configured"**
- Double-check the database ID is exactly 32 characters
- Ensure it's the database ID, not the page ID
- Verify the database exists and is shared with your integration

**Error: "Directory does not exist"**
- Check the brain dump directory path is correct
- Use absolute paths or `~/` for home directory
- Ensure the directory exists and is readable

### API Issues

**Error: "Invalid API key" (OpenAI)**
- Regenerate your OpenAI API key
- Ensure your OpenAI account is active
- Check for any account spending limits

**Error: "Unauthorized" (Notion)**
- Verify your Notion integration token is correct
- Ensure the database is shared with your integration
- Check the integration has the correct permissions

**Error: "Database not found" (Notion)**
- Double-check the database ID
- Ensure the database hasn't been moved or deleted
- Verify integration permissions

### Database Schema Issues

**Error: "Missing required database properties"**
- Ensure all required columns exist with exact names
- Check column types match requirements
- Create missing columns in your Notion database

**No tasks appear despite successful sync**
- Check if tasks already exist (deduplication at work)
- Verify your markdown files contain recognisable task patterns
- Check the logs for extraction details

### Performance Issues  

**Sync takes very long**
- Large files are automatically chunked
- API rate limits may cause delays
- Check your OpenAI account rate limits

**Hourly sync not running**
- Ensure "Enable Hourly Background Sync" is checked
- Raycast must be running for background tasks
- Check Raycast's background app refresh settings

### Debugging

**Check Logs**
```bash
# View recent log entries
tail -f ~/Library/Application\ Support/com.raycast.macos/extensions/brainpipe/brainpipe.log

# Or check logs in the extension code
open ~/Library/Application\ Support/com.raycast.macos/extensions/
```

**Enable Debug Logging**
- Logs are automatically written to both Raycast console and files
- Use Raycast's developer console to see real-time output
- Check the rotating log file for historical data

## Privacy & Security

- **API Keys**: Stored securely in Raycast's encrypted preferences
- **Data Processing**: Your markdown files are only read, never modified
- **OpenAI Usage**: Calls OpenAI directly with your API key (not Raycast Pro)
- **Local State**: Task hashes and file timestamps stored locally
- **No Telemetry**: No usage data sent to third parties

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test extractor.test.ts
```

### Project Structure

```
src/
├── extractor.ts      # OpenAI integration and task extraction
├── ingest.ts         # File scanning and content reading
├── log.ts           # Logging system with file rotation
├── notion.ts        # Notion API integration
├── runner-hourly.ts # Background scheduled command
├── runner-manual.ts # Manual command with UI feedback
└── state.ts         # State management and deduplication

__tests__/
├── extractor.test.ts
├── ingest.test.ts  
├── notion.test.ts
└── state.test.ts
```

### Building

```bash
# Development build
npm run dev

# Production build  
npm run build

# Lint and fix
npm run fix-lint
```

## Smoke Test Checklist

Use this checklist to verify everything is working:

### Initial Setup
- [ ] Extension loads in Raycast without errors
- [ ] All preferences can be configured
- [ ] Health check passes (run manual sync to verify)

### File Processing
- [ ] Creates test markdown file with tasks
- [ ] Manual sync processes the file successfully
- [ ] Tasks appear in Notion with correct properties

### Deduplication  
- [ ] Running sync twice doesn't create duplicate tasks
- [ ] Modifying file and re-syncing only processes new content
- [ ] Completed tasks (- [x]) are ignored

### Date Processing
- [ ] `due:16/08` becomes current year + correct date
- [ ] `due:2025-08-20` remains unchanged
- [ ] Tasks without dates have empty Due Date field

### Error Handling
- [ ] Invalid API keys show helpful error messages
- [ ] Missing database columns are detected
- [ ] Network errors are handled gracefully
- [ ] Large files are processed without timeouts

### Background Operation
- [ ] Hourly sync can be enabled/disabled
- [ ] Background sync runs without UI (check logs)
- [ ] Manual sync provides proper feedback

## Support

For issues, feature requests, or contributions:

1. Check the troubleshooting section above
2. Review logs for specific error messages
3. Verify all setup steps are completed correctly
4. Test with a simple markdown file first

Remember: This extension calls OpenAI directly using your API key, so you have full control over usage and costs.