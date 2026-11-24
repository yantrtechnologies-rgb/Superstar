# Meta App Review: Superstar Social (app 2414730979331172)

This file holds the text to paste into Meta's App Review forms, the screen-recording script, and the reviewer
instructions. It only requests permissions that Superstar actually uses (`packages/data/src/meta-connection.ts`
and `packages/data/src/meta.ts`). Meta rejects requests for permissions an app does not use.

## Before submitting

1. **Tech Provider**: Dashboard → "Become a Tech Provider" → "Yes". This cannot be undone. It is the correct
   choice because Superstar posts to Pages and Instagram accounts that belong to other businesses (its customers).
2. **Business verification** of Xolnet Technologies: Meta Business Suite → Settings → Business info →
   Business verification. Needs the legal business name, address and phone exactly as on an official document
   (for example GST registration, certificate of incorporation, or a utility bill in the business name), and a
   business email or domain. Usually takes 1–5 working days.
3. **A site reviewers can open for the whole review** (often 3–10 days). The ngrok address works only while the
   PC is on and the start script is running. Keep the PC on, or deploy Superstar to a permanent host first.
4. **A reviewer login for Superstar**: create a dedicated account (for example `meta-review@…`) with a workspace,
   confirm its email, and put the email and password in the "Instructions for reviewers" box only.
5. **App icon** (1024×1024) and **category** (Business and Pages / Productivity) on App settings → Basic.

## Permissions to request (Advanced Access)

### pages_show_list
**How Superstar uses it:** After a customer connects Facebook, Superstar lists the Facebook Pages the customer
manages so they can choose which Pages to add to their Superstar workspace as publishing channels. Superstar
reads only each Page's ID and name.

### pages_read_engagement
**How Superstar uses it:** Superstar reads basic information about the Pages the customer selected (Page ID,
name and the linked Instagram professional account) so it can show the connected Page in the customer's
channel list and confirm the connection is working before publishing.

### pages_manage_posts
**How Superstar uses it:** Superstar is a social media scheduler. Customers write a post (text, link or image)
in Superstar, choose their connected Facebook Page and a date and time, and Superstar publishes the post to that
Page at the scheduled time. Customers can also publish immediately. Superstar posts only content the customer
wrote and scheduled, and only to Pages the customer explicitly connected.

### pages_manage_engagement
**How Superstar uses it:** Customers can schedule a thread: a main post followed by follow-up comments. Superstar
publishes the follow-up items as comments from the Page on the Page's own post, in the order and at the time the
customer chose. Superstar does not read, reply to or moderate other people's comments.

### pages_read_user_content
**How Superstar uses it:** Superstar's Inbox shows the comments people leave on posts the customer published through
Superstar on their connected Page, including the commenter's name, so the customer can read and answer them in one
place. Superstar reads comments only for the customer's own Page posts from the last 30 days and does not store them.

### instagram_manage_comments
**How Superstar uses it:** Superstar's Inbox lists comments on Instagram posts the customer published through
Superstar and lets the customer reply to a comment as their Instagram professional account. Comments are read live
and not stored; replies are sent only when the customer writes one and clicks Send reply.

### instagram_basic
**How Superstar uses it:** Superstar reads the ID and username of the Instagram professional account linked to
the customer's Facebook Page, so the customer can select it as a publishing channel and see which account a
post will go to.

### instagram_content_publish
**How Superstar uses it:** Customers write a caption and attach an image in Superstar, choose their connected
Instagram professional account and a time, and Superstar publishes the image post to that Instagram account at
the scheduled time (or immediately). Superstar publishes only content the customer created and scheduled.

## Screen-recording script (one video, about 3 minutes, English UI, no sound needed)

Record in a fresh private window. Show the browser address bar throughout.

1. Open the Superstar site and sign in with the reviewer account.
2. Go to **Channels → Continue with Facebook for Pages**. Show the Facebook login and the permission dialog
   listing the Page permissions. Choose a test Page and approve.
3. Back in Superstar, show the Page list (**pages_show_list**), select the Page and save. Show it in the
   channel list with its name (**pages_read_engagement**).
4. Go to **Posts → New post**. Write a short post, attach an image, select the Facebook Page, click
   **Publish now**. Open the Page on Facebook and show the published post (**pages_manage_posts**).
5. Create a thread: main post plus one follow-up item, publish it, and show the follow-up appearing as a comment
   from the Page under the post (**pages_manage_engagement**).
6. Go to **Channels → Continue with Facebook for Instagram**. Approve, then show the Instagram professional
   account username in Superstar (**instagram_basic**).
7. Create a post with a caption and image, select the Instagram account, publish, then open Instagram and show
   the published post (**instagram_content_publish**).
8. Comment on the Facebook post and the Instagram post from another account. In Superstar open **Inbox**, show both
   comments (**pages_read_user_content**, **instagram_manage_comments**), reply to each with **Send reply**, then show the
   replies on Facebook and Instagram (**pages_manage_engagement**, **instagram_manage_comments**).
9. Show **Disconnect** on a channel, to demonstrate the customer stays in control.

## Instructions for reviewers (paste into the review form)

> Superstar is a social media scheduling tool. Businesses connect their own Facebook Pages and Instagram
> professional accounts, then write and schedule posts that Superstar publishes for them.
>
> 1. Open https://citizen-reaction-abdomen.ngrok-free.dev/login and sign in with: [reviewer email] / [reviewer password].
>    If you see "The database is starting up", wait about 5 minutes; the page refreshes by itself.
> 2. Go to Channels and click "Continue with Facebook for Pages". Log in with your Facebook test user and approve.
>    Select a Page and save.
> 3. Go to Posts → New post, write a message, select the Page, and click "Publish now". The post appears on the Page.
> 4. For Instagram, click "Continue with Facebook for Instagram" on the Channels page, select the linked
>    Instagram professional account, then publish a post with an image from Posts → New post.
>
> Superstar only publishes content the user writes, only to accounts the user connected, and stores access
> tokens encrypted. Users can disconnect any account at any time from the Channels page.

## After approval

- Switch each permission to **Advanced Access** if Meta does not do it automatically.
- Testers no longer need to be added under App roles.
