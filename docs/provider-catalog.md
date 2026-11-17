# Provider catalog

Inventory from the brief, with known destination distinctions to verify. Research date 2026-11-17. [Postiz documentation index](https://docs.postiz.com/llms.txt) and [public channel navigation](https://postiz.com/pricing) are reference discovery sources. Official endpoint, scope, quota and approval research is pending where the row has no source. Live evidence requires a permitted test destination, working credentials and a recorded provider response or permalink for each enabled publishing behavior.

| Connector | Destination or behavior to verify |
| --- | --- |
| X | Account, threads and media |
| LinkedIn profiles | OAuth and public text publishing implemented through the self-serve Share on LinkedIn API. Requires Share on LinkedIn and OpenID Connect products, a registered redirect and `w_member_social`. Programmatic refresh depends on LinkedIn eligibility. Document posts and live verification are pending. [Member publishing](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) · [Refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens) |
| LinkedIn Pages | Pending. Organization publishing uses `w_organization_social` and a supported Page role. Organic documents and sponsored Carousel are separate request types. [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) |
| Reddit | Subreddit posting, flair and title |
| Instagram via Facebook | Pending. Facebook Page token and linked professional account. Graph host, Page publishing authorization and applicable scopes differ from Instagram Login. Media uses container creation, a status check and publication. [Meta Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing) |
| Instagram Login | Pending. Instagram user token, graph.instagram.com, and `instagram_business_basic` plus `instagram_business_content_publish`. Validate stories and trial reels against exact account and API conditions. [Meta Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing) |
| Facebook Pages | Page selector and publishing permissions |
| Threads | Profile, media and replies |
| YouTube | Pending. Upload through videos.insert. Google removed the blanket private-only restriction on uploads from unverified API projects on November 2, 2026. OAuth project access and account-specific visibility still require live verification. [Video uploads](https://developers.google.com/youtube/v3/docs/videos/insert) · [Revision history](https://developers.google.com/youtube/data/revision_history#november-2-2026) |
| Google Business Profile | Location; updates, offers and events |
| TikTok | Pending. Direct Post uses `video.publish`, requires creator settings and consent, and has an audit gate for public visibility. Inbox upload uses `video.upload` and requires the user to finish in TikTok. URL-based transfers require verified ownership. [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post) · [Inbox upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video) |
| TikTok Business | Separate adapter and permissions to confirm |
| Pinterest | Board, destination link and video cover |
| Dribbble | Shot creation access |
| Kick | Supported destination and write operation |
| Twitch | Supported destination and write operation |
| VK | User or community wall |
| Discord | Server text channels. Operator bot grants gate discovery and publishing. [Create Message](https://docs.discord.com/developers/resources/message#create-message) supports the text, attachment and nonce contract. Live test bot evidence pending. |
| Slack | Operator bot token and workspace channel grant. Text only. Requires channel membership, `chat:write` and applicable conversation read scope. Tested with simulated responses. [Discovery](https://docs.slack.dev/reference/methods/conversations.info/) · [Publish](https://docs.slack.dev/reference/methods/chat.postMessage/) · [Permalink](https://docs.slack.dev/reference/methods/chat.getPermalink/) |
| Telegram | Operator bot token and workspace grant for a channel or supergroup. Text and single photo, with 1,024-character photo captions. Member-count snapshots use getChatMemberCount. Tested with simulated responses. [Bot API](https://core.telegram.org/bots/api) · [Message links](https://core.telegram.org/api/links#message-links) |
| Mastodon | Instance URL, OAuth and instance limits |
| Bluesky | Account authorization, facets and threading |
| Lemmy | Instance and community |
| Farcaster | Signer authorization and upstream transport |
| Nostr | Signing and relay publication |
| Moltbook | Connector presence in pinned source and supported authorization |
| Whop | App permissions and destination selection |
| Skool | Connector method and permitted handoff |
| MeWe | Connector method and permitted handoff |
| Tumblr | Blog selection and posting access |
| Medium | Existing-token access and canonical URL |
| Dev.to | Article, publishing state and canonical URL |
| Hashnode | Publication, author permissions and canonical URL |
| WordPress | Site-specific authentication and post settings |
| ListMonk | List selection, campaign creation and send semantics |
