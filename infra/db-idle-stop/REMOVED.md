# Removed from AWS on 2026-11-23

The idle-stop function, its 15-minute schedule, its two IAM roles and its log group were deleted from
ap-southeast-2 at the owner's request, so `superstar-db` now runs continuously.

Do not run `deploy.sh` again unless you want the database to stop itself after 45 idle minutes.
The app still starts a stopped database automatically when someone opens the sign-in page.
