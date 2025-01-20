require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const schedule = require('node-schedule');
const os = require('os');

// Load bot token from environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    throw new Error('Telegram bot token not found. Set TELEGRAM_BOT_TOKEN in .env file.');
}

const bot = new TelegramBot(token, { polling: true });

// Supported domains for media download
const SUPPORTED_DOMAINS = [
    'youtube.com',
    'youtu.be',
    'vimeo.com',
    'dailymotion.com',
    'soundcloud.com',
    'facebook.com',
    '1024terabox.com',
    'instagram.com',
];

// Downloads directory
const downloadsDir = path.resolve(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Manage active downloads
let activeDownloadCount = 0;
const maxConcurrentDownloads = 5; // Limiting concurrent downloads
let currentDownloadProcess = null; // Track the current download process

// User log file path
const userLogFilePath = path.resolve(__dirname, 'user_logs.txt');

// Log user actions
function logUserAction(chatId, action) {
    const logData = {
        chatId,
        action,
        timestamp: new Date().toISOString(),
        ip: 'Unavailable', // User IP logging would need Telegram API to fetch through webhook (otherwise, this is not directly accessible)
    };
    fs.appendFileSync(userLogFilePath, JSON.stringify(logData) + os.EOL);
}

// Normalize YouTube Shorts URLs to regular YouTube links
function normalizeUrl(url) {
    if (url.includes('youtube.com/shorts/')) {
        const videoId = url.split('/shorts/')[1]?.split('?')[0];
        return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
}

// Check if the domain is supported
function isSupportedDomain(url) {
    try {
        const { hostname } = new URL(url);
        return SUPPORTED_DOMAINS.some((domain) => hostname.includes(domain));
    } catch {
        return false;
    }
}

// Download media (audio/video)
function downloadMedia(url, format, isAudio, chatId) {
    if (activeDownloadCount >= maxConcurrentDownloads) {
        bot.sendMessage(chatId, '⏳ The download queue is full. Please wait until a slot becomes available.');
        return;
    }

    activeDownloadCount++;
    const extension = isAudio ? 'mp3' : 'mp4';
    const fileName = `${Date.now()}.${extension}`;
    const filePath = path.join(downloadsDir, fileName);

    return new Promise((resolve, reject) => {
        const ytDlpPath = 'C:/ytdlp/yt-dlp.exe'; // Update this path as needed (for Windows)
        const command = `"${ytDlpPath}" -f ${format} -o "${filePath}" ${url}`;
        console.log('Executing command:', command);

        currentDownloadProcess = exec(command, (error, stdout, stderr) => {
            activeDownloadCount--;
            currentDownloadProcess = null; // Reset on completion

            if (error) {
                console.error(`Download error: ${stderr}`);
                reject(`❌ Download error: ${stderr}`);
                return;
            }
            console.log(`Download complete: ${stdout}`);
            resolve(filePath);
        });

        // If user stops download, kill the process
        currentDownloadProcess.on('close', () => {
            activeDownloadCount--;
            currentDownloadProcess = null; // Reset on close
        });
    });
}

// Periodic cleanup of downloads directory (daily)
schedule.scheduleJob('0 0 * * *', () => {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            console.error('Failed to clean up downloads directory:', err);
            return;
        }

        files.forEach((file) => {
            fs.unlinkSync(path.join(downloadsDir, file));
        });
        console.log('Daily cleanup complete.');
    });
});

// Start command
bot.onText(/\/start/, (msg) => {
    const firstName = msg.chat.first_name || 'User';
    logUserAction(msg.chat.id, 'start');
    bot.sendMessage(
        msg.chat.id,
        `👋 Welcome, ${firstName}! Use the following commands:
        - /audio <URL> to download audio
        - /video <URL> to download video
        - /delete to clean up downloaded files
        - /help for instructions
        - /mute-video <URL> to download video without audio
        - /stop to stop the current download`
    );
});

// Help command
bot.onText(/\/help/, (msg) => {
    const helpText = `...`;  // As before, with additional security and privacy notes.
    logUserAction(msg.chat.id, 'help');
    bot.sendMessage(msg.chat.id, helpText);
});

// Download handler (audio/video)
bot.onText(/\/(audio|video) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const command = match[1];
    const url = match[2]?.trim();

    if (!url || !url.startsWith('http')) {
        bot.sendMessage(chatId, '⚠️ Please provide a valid URL.');
        return;
    }

    const normalizedUrl = normalizeUrl(url);

    if (!isSupportedDomain(normalizedUrl)) {
        bot.sendMessage(chatId, '❌ This URL is not supported.');
        return;
    }

    const isAudio = command === 'audio';
    const format = isAudio ? 'bestaudio' : 'bestvideo+bestaudio';

    bot.sendMessage(chatId, `⏳ Downloading ${isAudio ? 'audio' : 'video'}...`);
    logUserAction(chatId, `${command} ${normalizedUrl}`);

    try {
        const filePath = await downloadMedia(normalizedUrl, format, isAudio, chatId);

        // Send the file to the user
        if (isAudio) {
            await bot.sendAudio(chatId, filePath);
        } else {
            await bot.sendVideo(chatId, filePath);
        }

        fs.unlinkSync(filePath); // Delete file after sending
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, error || '❌ Download failed. Please try again.');
    }
});

// Mute Video Download Command (/mute-video)
bot.onText(/\/mute-video (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1]?.trim();

    if (!url || !url.startsWith('http')) {
        bot.sendMessage(chatId, '⚠️ Please provide a valid URL.');
        return;
    }

    const normalizedUrl = normalizeUrl(url);

    if (!isSupportedDomain(normalizedUrl)) {
        bot.sendMessage(chatId, '❌ This URL is not supported.');
        return;
    }

    const isAudio = false; // Mute video, no audio
    const format = 'bestvideo'; // Video without audio

    bot.sendMessage(chatId, '⏳ Downloading video without audio...');
    logUserAction(chatId, `mute-video ${normalizedUrl}`);

    try {
        const filePath = await downloadMedia(normalizedUrl, format, isAudio, chatId);

        // Send the video to the user
        await bot.sendVideo(chatId, filePath);

        fs.unlinkSync(filePath); // Delete file after sending
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, error || '❌ Download failed. Please try again.');
    }
});

// Stop the current download Command (/stop)
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;

    if (!currentDownloadProcess) {
        bot.sendMessage(chatId, '❌ No download in progress.');
        return;
    }

    currentDownloadProcess.kill('SIGINT'); // Terminate the current download process
    currentDownloadProcess = null; // Reset current download process

    bot.sendMessage(chatId, '🛑 Download stopped successfully.');
});

// Delete command
bot.onText(/\/delete/, (msg) => {
    const chatId = msg.chat.id;

    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            bot.sendMessage(chatId, '❌ Failed to delete files.');
            return;
        }

        if (files.length === 0) {
            bot.sendMessage(chatId, '⚠️ No files to delete.');
            return;
        }

        files.forEach((file) => {
            fs.unlinkSync(path.join(downloadsDir, file));
        });

        bot.sendMessage(chatId, '🗑️ All downloaded files have been deleted.');
    });
});

// Invalid command handler and automatic help message for any non-command input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.toLowerCase().trim();

    if (text === 'hi' || text === 'hello') {
        const firstName = msg.chat.first_name || 'User';
        bot.sendMessage(
            chatId,
            `👋 Hello, ${firstName}! Welcome to the Media Downloader Bot! Use /help to see available commands.`
        );
    } else if (!text.startsWith('/')) {
        // For any other text that isn't a command
        bot.sendMessage(chatId, '❌ Invalid command or message. Use /help command for available commands.');
    }
});

// Polling error handler
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.response?.body || error.message);
});

console.log('Bot is running...');
