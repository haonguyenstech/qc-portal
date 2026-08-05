ID,Feature,Test suite,Summary,Pre-condition,Steps,Expected result,Actual result,Priority,Status,Reference,Note
No-01,Notification,Appointment,Verify System admin login successfully without any error,,"1. Go to DEV URL
2. The system show 'Log in to your account' with two tab are 'email' and 'OTP' 
3. Click on 'OTP' tab 
4. Click on 'By Email' button
5. Enter Email data into 'Email' field 
6. Click on 'Send OTP' button 
7. Enter OTP data into OTP number field
8. Click on 'Log in' button 
9. Observe UI",1. The system displayed 'Appointment Management' screen as default,,,,,
No-02,Notification,Appointment,Verify notification creation in the bell icon when an appointment is created under a System admin account.,"1. Login screen is showing 
2. User click on 'Appointment' on left menu 
3. Click on 'Create New' button on right corner 
4. THe 'Create New Appointment' screen is displayed 
5. At 'Basic Information' card => select 'Existing Patient' option 
6. Click on 'Existing Patient List' field  
7. Click on Search => enter <Patient Name data> into search textbox 
8. Select patient at step 7 
9. At 'Booking Information'/ 'Visit Type' => Select any option on dropdown list 
10. At 'Clinician' field => select <Clinician Name data>
11. At 'Duration' field => select option 30min 
12. At 'Date' field => choose today 
13. Select data for the 'Start Time' and 'End Time' fields that is half an hour ahead of the actual time. 
14. Click on 'Create' button","1. Make sure appointment was created => click refresh page to make sure new appointment show in bell icon
2. Click on Notification center/ Bell icon
3. Observe UI 
4. User click on 'View All' button 
5. The system direct to 'Notification Center' screen 
6. Check the unread count at the 'Unread' card 
7. Check the count at the 'Low' card
8. At 'All' tab -> Check the first record in the notification list. 
","1.  At step3, System admin receives unread notification with these informations 
a. Name = Appointment Created. 
b. Message = Your appointment with <Patient Name data> has been created. 
2. At step 6, unread badge changes from N to N+1.
3. At step 7, low card changes from N to N+1 
4. At step 8, notification is displayed as unread. 
a. at 'Notification' column in table show Name and Message the same as expected 1  
b. 'Functions' column show data as 'Appointment' 
c. 'Priority' column data marked to 'Low'
d. The data in the 'Time' column is displayed according to the date the user created the appointment.",,,,,
No-03,Notification,Appointment,Verify that system admin can view created notification without any error,1. Make sure test case No-02 was created,"1. The 'Notification Center' screen is showing 
2. System admin click on first record that created in test case 'No-02'
3. Observe new slide card showing
4. Check the unread count at the 'Unread' card 
5. Check the count at the 'Low' card ","1. At step 3, the new slide card show with these informations: 
a. Low card 
b. show Name and Message  
+ Name = Appointment Created. 
+ Message = Your appointment with <Patient Name data> has been created. 
c. Show priority equal to 'Low' 
+ function as 'Appointment' 
+ Date & Time is displayed according to the date the user created the appointment.
d. Show 'Appointment Details' card with these informations: 
+ Visit type show as the same with user setup data before 
+ Date show the same as user setup before 
+ consent form data 
e. Show 'patient details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-04,Notification,Appointment,Verify notification creation in the bell icon when an appointment is created assinged a Clinician account.,1. Ensure appointment at test case at 'No-02' test case was created ,"1. Login as <Clinician account data>
2. Click on Notification center/ Bell icon 
3. Observe UI","1. System admin received unread notification with these informations
a. Name = Appointment Created. 
b. Message = Your appointment with <Patient Name data> has been created. ",,,,,
No-05,Notification,Appointment,Verify that Clinician account can view newly created appointment notification via Notification Center screen ,1. Ensure appointment at test case 'No-02' was created ,"1. Login as <Clinician account data>
2. Click on Notification center/ Bell icon 
3. User can see first notification is 
   a. Name = Appointment Created. 
   b. Message = Your appointment with <Patient Name data> has been created. 
4. User click on first notification, then the system direct to 'Notification Center' screen 
5. Click refresh page 
6. Check the unread count at the 'Unread' card 
7. Check the count at the 'Low' card
8. At Search textbox, try to search with keyword ""Appointment Created"" 
9. Observe latest record in result table  
10. Click on first record in result table => Observe","1. At step 6, unread badge changes from N to N+1.
2. At step 7, low card changes from N to N+1 
3. At step 9, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message at step3 
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Low' data 
   d. Under 'Time' column show time to create appointment
5. At step 10, new slider from right to left with these information:
   a. Low card 
   b. Name and Message as step 3 
   c. 'Priority' show as 'Low' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' show as date time create appoint in test case 'No-02' 
   f. 'Appointment Details' card with  Visit type - Dat &Time user setup for appointment before - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-06,Notification,Appointment,Verify that System admin account can view patient details via notification center screen,1. Ensure appointment at test case 'No-02' was created ,"1. Login as <System account data>
2. Click on Notification center/ Bell icon 
3. User click on first notification, then the system direct to 'Notification Center' screen 
4. At Search textbox, try to search with keyword ""Appointment Created"" 
5. Observe latest record in result table  
6. Click on first record in result table => Observe new slider displayed 
7. Click on 'View details' button next to 'Appointment Details' card 
8. Observe","1. At Step8, the system direct to 'View Appointment' screen with these info 
a. Booked status 
b. Basic Information and  Booking information card contain all informations that user setup as test case 'No-02'",,,,,
No-07,Notification,Appointment,Verify that Clinician account can view patient details via notification center screen,1. Ensure appointment at test case 'No-02' was created ,"1. Login as <Clinician account data>
2. Click on Notification center/ Bell icon 
3. User click on first notification, then the system direct to 'Notification Center' screen 
4. At Search textbox, try to search with keyword ""Appointment Created"" 
5. Observe latest record in result table  
6. Click on first record in result table => Observe new slider displayed 
7. Click on 'View details' button next to 'Appointment Details' card 
8. Observe","1. At Step8, the system direct to 'View Appointment' screen with these info 
a. Booked status 
b. Basic Information and  Booking information card contain all informations that user setup as test case 'No-02'",,,,,
No-08,Notification,Appointment,Verify unassigned clinician does not receive appointment created notification,,"1. Login as other clinician account (ht01@yopmail.com/ 123123) 
2. Click on Notification center/ Bell icon 
3. Observe UI",1. No appointment notification as test case 'No-02' is generated,,,,,
No-09,Notification,Appointment,Verify notification is not created when appointment creation fails,1. Appointment creation form is open. Required field is missing.,"1. Try to create appointment without required data by <System account data> | <Clinician account data>
2. Click on 'Create' button. 
3. Check Notification Center of assigned clinician/admin.",1. Appointment is not created. No appointment notification is generated.,,,,,
No-10,Notification,Appointment,Verify notification when appointment date/time is changed under System admin account,"1. Ensure appointment at test case at 'No-02' test case was created 
2. System admin go to 'Appointment Management' page 
3. User click on 'List View' tab => Search as <Patient Name data> on search text box 
4. In result screen => click 'Edit Appointment' action of first item via button '...' next to 'Status' column
5. 'Edit Appointment' screen is showing 
6. User change 'Date' || 'Start Time' || 'End time' field different with orginal data 
7. Click Save button  
8. The successfully message is displayed under bottom page And the system direct to 'Appointment Management' screen","1. Make sure appointment was updated 
2. Click on Notification center/ Bell icon
3. Observe UI","1. System admin receives unread notification with these informations 
a. Name = Appointment Rescheduled
b. Message = Your appointment with patient <Patient Name data> has been re-scheduled.
",,,,,
No-11,Notification,Appointment,Verify that system admin can view appointment updated notice detail via notification center screen,1. Make sure appointment was updated in test case 'No-10' finished,"1. Make sure appointment was updated 
2. Click on Notification center/ Bell icon
3. The user can view latest notification with expected info in test case 'No-08'
4. User click on first record 
5. The system direct to 'Notification Center' screen 
6. User click refresh page => Observe UI
7. User search with keyword 'Appointment Rescheduled' in search textbox under ""All' tab 
8. Observe first record on result table 
9. Click on first record on result table => Observe","1. After user refresh page at step6 , unread badge and  Medium card  changes from N to N+1. 
2. At step 8, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as expected of test case 'No-08'
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Medium' data 
   d. Under 'Time' column show time to updated appointment
5. At step 9, new slider from right to left with these information:
   a. Medium card 
   b. Name and Message as expected of test case 'No-08'
   c. 'Priority' show as 'Medium' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' show as date time create appoint in test case 'No-02' 
   f. 'Appointment Details' card with  Visit type - Dat &Time user updated for appointment at test case 'No-08' - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-12,Notification,Appointment,Verify that clinician can receivd notification when appointment date/time is changed under super admin account,1. Make sure appointment has been changed Date/ Time under super admin account in test case  'No-10' ,"1. Login as Clinician account 
2. Click on bell icon 
3. Observe UI","1. Clinician account receives unread notification with these informations 
a. Name = Appointment Rescheduled
b. Message = Your appointment with patient <Patient Name data> has been re-scheduled.
",,,,,
No-13,Notification,Appointment,Verify that Clinician account can view newly updated appointment notification via Notification Center screen ,1. Make sure appointment was updated in test case 'No-10' finished,"1. Login as <Clinician account data>
2. Click on Notification center/ Bell icon 
3. User can see first notification is 
   a. Name = Appointment Rescheduled
   b. Message = Your appointment with patient <Patient Name data> has been re-scheduled.
4. User click on first notification, then the system direct to 'Notification Center' screen 
5. Click refresh page 
6. Check the unread count at the 'Unread' card 
7. Check the count at the 'Low' card
8. At Search textbox, try to search with keyword ""Appointment Rescheduled"" 
9. Observe latest record in result table  
10. Click on first record in result table => Observe","1. At step 6, unread badge changes from N to N+1.
2. At step 7, low card changes from N to N+1 
3. At step 9, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message at step3 
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Low' data 
   d. Under 'Time' column show time to create appointment
5. At step 10, new slider from right to left with these information:
   a. Medium card 
   b. Name and Message as step 3 
   c. 'Priority' show as 'Low' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' show as date time create appoint in test case 'No-02' 
   f. 'Appointment Details' card with  Visit type - Dat &Time user updated for appointment before - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-14,Notification,Appointment,Verify that Clininian can receivd notification when appointment date/time is changed under Clinician account,1. Make sure appointment has been changed Date/ Time under Clinician account ,"1. Login as Clinician account 
2. Click on bell icon 
3. Observe UI","1. Clinician receives unread notification with these informations 
a. Name = Appointment Rescheduled
b. Message = Your appointment with patient <Patient Name data> has been re-scheduled.
",,,,,
No-15,Notification,Appointment,Verify that System admin can receivd notification when appointment date/time is changed under Clinician account,1. Make sure appointment has been changed Date/ Time under Clinician account ,"1. Login as System admin account 
2. Click on bell icon 
3. Observe UI","1. Super admin receives unread notification with these informations 
a. Name = Appointment Rescheduled
b. Message = Your appointment with patient <Patient Name data> has been re-scheduled.
",,,,,
No-16,Notification,Appointment,Verify notification when appointment details are changed,1. Existing appointment above assigned to <Clinician Name data> . And Date/time is unchanged.,"0. Login as <System account data> | <Clinician account data>
1. Edit appointment. 
2. Change details such as visit type, note, room, or other appointment information. 
3. Save. 
4. Check Notification Center.
","1. Super admin/ Clinician receives notification with these information below:
a. Name = Appointment Details Updated 
b. Message = Your appointment with patient <Patient Name data> has been updated with new details. Please review them.",,,,,
No-17,Notification,Appointment,Verify Appointment Details updated notification via notification center screen,1. Existing appointment above assigned to <Clinician Name data> . And Date/time is unchanged.,"1. Appointment in test case 'No-14' was updated 
2. click on Bell icon -> the user can see these info
a. Name = Appointment Details Updated 
b. Message = Your appointment with patient <Patient Name data> has been updated with new details. Please review them.
3. Click on this notification => The system direct to 'Notification center' screen 
4. Click refresh page
5. Try to search 'Appointment Details Updated' in search textbox 
6. Observe UI 
7. Click on first record on result table 
8. Observe ","1. at step6 , unread badge and  Medium card  changes from N to N+1. 
2. At step 6, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as step2
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Medium' data 
   d. Under 'Time' column show time to updated appointment
5. At step 8, new slider from right to left with these information:
   a. Medium card 
   b. Name and Message as expected as step 2
   c. 'Priority' show as 'Medium' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' data
   f. 'Appointment Details' card with  Visit type - Dat &Time - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-18,Notification,Appointment,Verify notification when appointment is confirmed via bell icon,"1. The appointment must be made one hour before check-in time by <System account data> | <Clinician account data> and not confirm yet 
2. Appointment was assigned to <Clinician Name data>","1. Login as <System account data> | <Clinician account data> 
2. Click on 'Appointment' on left menu tab 
3. Click on 'List View' tab 
4. At search textbox => try to search with <clinician name data>
5. Click on '...' action button 
6. Click on 'Confirm' button of first item 
7. Go to Bell icon to check newly notification","1.<System account data> | <Clinician account data> receives notification with these information 
a. Name = Appointment Confirmed notification.
b. Message = Appointment with patient <Patient Name data> has been confirmed.",,,,,
No-19,Notification,Appointment,Verify notification when appointment is confirmed via notification center screen,1. The appointment was created in test case 'No-18' is available,"1. Login as <System account data> | <Clinician account data> 
2. Click on Bell icon 
3. The system show these info in first record 
   a. Name = Appointment Confirmed.
   b. Message = Appointment with patient <Patient Name data> has been confirmed.
4. User click on first record => the system direct to 'Notification center' screen 
4.5: refresh page
5. Try to search 'Appointment Confirmed' in search textbox 
6. Observe 
7. Click on first result in result table 
8. Observe","1. at step6 , unread badge and  Medium card  changes from N to N+1. 
2. At step 6, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as step3
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Medium' data 
   d. Under 'Time' column show time to updated appointment
5. At step 8, new slider from right to left with these information:
   a. Medium card 
   b. Name and Message as expected as step 3
   c. 'Priority' show as 'Medium' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' data
   f. 'Appointment Details' card with  Visit type - Dat &Time - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-20,Notification,Appointment,Verify notification when appointment is cancelled via bell icon,1. Existing appointment assigned to Clinician account,"0.  Login as <System account data> | <Clinician account data> 
1. Cancel the appointment. 
2. Login as assigned clinician. 
3. Check Notification Center.
","1. User receives these information:
a. Name = Appointment Cancelled notification. 
b. Message = Appointment with patient <Patient Name data> has been cancelled. ",,,,,
No-21,Notification,Appointment,Verify that system admin can receive arrived notifications via bell icon,"1. Login as <System account data>
2. User click on 'Appointment' on left menu 
3. Click on 'Create New' button on right corner 
4. THe 'Create New Appointment' screen is displayed 
5. At 'Basic Information' card => select 'Existing Patient' option 
6. Click on 'Existing Patient List' field  
7. Click on Search => enter <Patient Name data> into search textbox 
8. Select patient at step 7 
9. At 'Booking Information'/ 'Visit Type' => Select any option on dropdown list 
10. At 'Clinician' field => select <Clinician Name data>
11. At 'Duration' field => select option 30min 
12. At 'Date' field => choose today 
13. 13. Select any date for the 'Start Time' and 'End Time' fields (avoid previously booked time slots and choose an appointment time one hour after the actual time).
14. Click on 'Create' button","1. Go to 'Appointment Management' screen 
2. Navigate to 'List View' tab 
3. At Search textbox, try to search <Patient Name data> 
4. Observe the first record  
5. Click 'Mark as arrived' button via action button 
6. Refresh page 
7. click on Bell icon => Observe ","1. User receives these information:
a. Name = Patient Arrived
b. Message = Appointment with patient <Patient Name data> has been changed to arrived",,,,,
No-22,Notification,Appointment,Verify that system admin can view arrived notifications via notification center screen,1. The appointment was created in test case 'No-21',"1. Login as  <System account data> 
2. Click on bell icon 
3. Click 'View all' button 
4. Search 'Patient Arrived' in search textbox 
5. Observe first result item 
6. refresh page
7. click on first record => Observe slide mode displayed","1. at step5 , unread badge and  Low card changes from N to N+1. 
2. At step 5, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as 
     . Name = Patient Arrived
     . Message = Appointment with patient <Patient Name data> has been changed to arrived
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Low' data 
   d. Under 'Time' column show time to updated appointment 
5. At step 7, unread badge card changes from N to N-1. 
6. At step 7, new slider from right to left with these information:
   a. Low card 
   b. Name and Message as expected as 
       Name = Patient Arrived
     . Message = Appointment with patient <Patient Name data> has been changed to arrived
   c. 'Priority' show as 'Low' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' data
   f. 'Appointment Details' card with  Visit type - Dat &Time - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-23,Notification,Appointment,Verify that Clinician account can receive arrived notifications via bell icon,1. The appointment was created in test case 'No-21',"1. Login as  <Clinician account data> 
2. click on Bell icon => Observe ","1. User receives these information in first record
a. Name = Patient Arrived
b. Message = Appointment with patient <Patient Name data> has been changed to arrived",,,,,
No-24,Notification,Appointment,Verify that Clinician account can view arrived notifications via notification center screen,1. The appointment was created in test case 'No-21',"1. Login as  <Clinician account data> 
2. Click on bell icon 
3. Click 'View all' button 
4. Search 'Patient Arrived' in search textbox 
5. Observe first result item 
6. refresh page
7. click on first record => Observe slide mode displayed","1. at step5 , unread badge and  Low card changes from N to N+1. 
2. At step 5, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as 
     . Name = Patient Arrived
     . Message = Appointment with patient <Patient Name data> has been changed to arrived
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Low' data 
   d. Under 'Time' column show time to updated appointment 
5. At step 7, unread badge card changes from N to N-1. 
6. At step 7, new slider from right to left with these information:
   a. Low card 
   b. Name and Message as expected as 
       Name = Patient Arrived
     . Message = Appointment with patient <Patient Name data> has been changed to arrived
   c. 'Priority' show as 'Low' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' data
   f. 'Appointment Details' card with  Visit type - Dat &Time - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
No-25,Notification,Appointment,Verify that system admin can view appointment details via notification center screen,1. The appointment was created in test case 'No-21',"1. Login as  <System account data> 
2. Click on bell icon 
3. Click 'View all' button 
4. Search 'Patient Arrived' in search textbox 
5. Observe first result item 
6. refresh page
7. click on first record => Observe slide mode displayed
8. Click on 'View details' button next to 'Appointment Details' card 
9. Observe","1. At Step9, the system direct to 'View Appointment' screen with these info 
a. Arrived status 
b. Basic Information and  Booking information card contain all informations that user setup as test case 'N0-19'",,,,,
No-26,Notification,Appointment,Verify that Clinician account can view appointment details via notification center screen,1. The appointment was created in test case 'No-21',"1. Login as  <Clinician account data> 
2. Click on bell icon 
3. Click 'View all' button 
4. Search 'Patient Arrived' in search textbox 
5. Observe first result item 
6. refresh page
7. click on first record => Observe slide mode displayed
8. Click on 'View details' button next to 'Appointment Details' card 
9. Observe","1. At Step9, the system direct to 'View Appointment' screen with these info 
a. Arrived status 
b. Basic Information and  Booking information card contain all informations that user setup as test case 'No-19'",,,,,
No-27,Notification,Appointment,Verify notification when appointment is cancelled via notification center screen,"1. Existing appointment assigned to Clinician account 
2. Make sure appointment in test case 'No-21' was canncelled","0.  Login as <System account data> | <Clinician account data> 
1. Click on bell icon
2. The system show latest notice as 
 a. Name = Appointment Cancelled. 
 b. Message = Appointment with patient <Patient Name data> has been cancelled. 
3. Click on first record 
4. The system direct to Notification center screen 
5. Refresh page => Observe UI 
6. Try to search with keyword 'Appointment Cancelled' in search textbox 
7. Observe latest record in result list 
8. Click on latest record above 
9. Observe","1. at step6 , unread badge and  Medium card  changes from N to N+1. 
2. At step 6, notification is displayed as unread. And show with these information below: 
  a. Under 'Notification' column -> show Name and Message as step2
  b. Under 'Functions' column show as 'Appointments' data 
  c. Under 'Priority' column show 'Low' data 
   d. Under 'Time' column show time to updated appointment
5. At step 9, new slider from right to left with these information:
   a. Medium card 
   b. Name and Message as expected as step 2
   c. 'Priority' show as 'Low' 
   d. 'Funcation' show as 'Appointment' 
   e. 'Date & Time' data
   f. 'Appointment Details' card with  Visit type - Dat &Time - one time - and consent form information 
   g. 'Patient Details' card with <Patient Name data> - <Patient MRN data > - <Patient gender data>",,,,,
