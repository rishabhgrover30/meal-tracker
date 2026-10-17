# Turn on Google Sheet sync (one-time, about 5 minutes)

**Use a laptop.** The Apps Script editor barely works in iPhone Safari: Google pushes you to the Drive app,
pasting 250 lines is fiddly, and the Run and Deploy dialogs are hard to use. Do this on a computer, signed in as rishabhgrover30@gmail.com.

1. Open the code: https://raw.githubusercontent.com/rishabhgrover30/meal-tracker/main/apps-script/Code.gs
   Select all (Cmd/Ctrl+A) and copy.
2. Open the sheet "Meal Tracker Log":
   https://docs.google.com/spreadsheets/d/1D0KjPb91cLB2mimfgy3Vg28UJx-kYKaRzYb4AjUheGU/edit
3. Go to **Extensions > Apps Script**. In Code.gs, select all, delete it, paste the code, then save (Cmd/Ctrl+S).
4. In the function dropdown at the top, choose **setup** and click **Run**.
   - Authorise: choose your account, then **Advanced > Go to … (unsafe)**, then **Allow**.
     (It's your own script, so Google shows this warning.)
   - The Execution log shows **"Your sync key is: …"**. Copy that key.
5. Click **Deploy > New deployment**. Click the gear and choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, and authorise again if asked.
6. Copy the **Web app URL** (it ends in **/exec**).
7. **Send your coach both the /exec URL and the key, in our private chat only.**
   Don't post them anywhere else: together they let someone write to your sheet.
8. Your coach sends you back two setup links, one for Meal Tracker and one for Workout.
   - **Home-screen apps** (they keep their own storage, separate from Safari): copy the link, open the app,
     paste it into the first box under **Google Sheet sync**, and tap **Save**.
     In Meal Tracker that's Settings; in Workout it's the Program tab, at the bottom.
   - In Safari, just tapping the link sets it up.

The status next to the app name reads "Synced 18:42" once it's working.

If the code changes later: **Deploy > Manage deployments > pencil > Version: New version > Deploy**. The URL and key stay the same.
To replace the key, run **rotateKey** and send the new key to your coach.
