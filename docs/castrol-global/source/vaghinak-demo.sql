-- Deck-only demo content: English Vaghinak messages (the app writes them in Armenian) and English titles for the automatic tasks.
-- Run on the LOCAL demo database only, right before shoot.mjs (the engine may add new Armenian messages on its next tick).
insert into vaghinak_settings(key,value) values ('mode','"live"') on conflict (key) do update set value='"live"';
delete from vaghinak_messages;
-- management (demo CEO, user 1)
insert into vaghinak_messages(user_id,kind,day,level,severity,body,shadow,created_at) values
(1,'mgmt_brief_issues',current_date,1,'info',E'Good evening, Director. Two things need your attention today:\n• Rep B started 41 min late (3rd time this week)\n• Rep C stopped after 4 of 9 planned visits\n\n• Plan completion: 78%\n• Late starts: 2',false, now()-interval '2 minutes'),
(1,'order_waiting_escalation',current_date,1,'info',E'Some orders have waited too long. Time to step in:\n• Orders: 4\n• Longest wait: 31 h\n• Task given to the sales director, deadline today 18:00',false, now()-interval '40 minutes'),
(1,'debt_promise_broken',current_date,1,'important',E'Promise broken: Garni Car Care promised to pay by 27 Oct, the debt is still open.\n• Collection task reopened for Rep C\n• Sales director informed',false, now()-interval '2 hours');
-- field rep (Rep A, user 2): friendly tone + a mandatory question
insert into vaghinak_messages(user_id,kind,day,level,severity,body,shadow,created_at) values
(2,'cluster_skip',current_date,1,'info',E'Nice work today! 2 planned shops are 200 m from your last stop: Kentron Auto and Arabkir Service. Drop in before you leave the area?',false, now()-interval '50 minutes'),
(2,'late_start',current_date,1,'info',E'Morning! The day started 31 min late. If something happened, just tell me.',false, now()-interval '7 hours');
insert into vaghinak_messages(user_id,kind,day,level,severity,body,needs_answer,mandatory,choices,shadow,created_at) values
(2,'stopped_early',current_date,2,'important',E'No check-in for 2 h 30 min and 5 planned visits are left. What is going on?',true,true,
 '[{"key":"lunch","label":"Lunch break"},{"key":"customer","label":"At a customer / waiting"},{"key":"car","label":"Car problem"},{"key":"done","label":"Finished the day"},{"key":"other","label":"Other"}]',false, now());
-- automatic tasks: English titles for the screenshots
update tasks set title = regexp_replace(title, '^Հավաքագրիր ([0-9,]+) դր պարտքը.*$', 'Collect the overdue debt (oldest invoice past due)') where auto_kind='debt_collection';
