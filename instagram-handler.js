import { IgApiClient } from 'instagram-private-api';
import User from './models/user.js'; // Ensure the path is correct

class InstagramHandler {
    constructor() {
        this.ig = new IgApiClient();
        this.ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);
    }

    async login() {
        try {
            await this.ig.simulate.preLoginFlow();
            await this.ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
            await this.ig.simulate.postLoginFlow();
            console.log('Instagram login successful');
        } catch (error) {
            console.error('Instagram login failed:', error);
            throw error;
        }
    }

    async handleDirectMessages(telegramBot) {
        try {
            const inbox = await this.ig.feed.directInbox().items();
            
            for (const thread of inbox) {
                const messages = thread.items;
                
                for (const message of messages) {
                    // Check if message is unread and contains media
                    if (!message.seen_at && message.media_share) {
                        await this.processMediaShare(message, thread.users[0], telegramBot);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling direct messages:', error);
        }
    }

    async processMediaShare(message, sender, telegramBot) {
        try {
            const mediaId = message.media_share.id;
            const mediaInfo = await this.ig.media.info(mediaId);
            
            // Find associated Telegram user
            const user = await User.findOne({ instagramId: sender.pk.toString() });
            
            if (!user || !user.telegramId) {
                // Send response asking user to connect their Telegram account
                await this.ig.direct.sendText({
                    userIds: [sender.pk],
                    text: 'Please connect your Telegram account first by sending /start to our Telegram bot: t.me/YourBotUsername'
                });
                return;
            }

            // Download and send video to Telegram user
            if (mediaInfo.video_versions && mediaInfo.video_versions.length > 0) {
                const videoUrl = mediaInfo.video_versions[0].url;
                await telegramBot.telegram.sendMessage(
                    user.telegramId,
                    'Processing your Instagram video...'
                );
                
                await telegramBot.telegram.sendVideo(
                    user.telegramId,
                    videoUrl,
                    { caption: 'Here\'s your Instagram video!' }
                );

                // Mark message as seen
                await this.ig.direct.markItemSeen(message.thread_id, message.item_id);
            }
        } catch (error) {
            console.error('Error processing media share:', error);
        }
    }
}

// Export the InstagramHandler class as the default export
export default InstagramHandler; 