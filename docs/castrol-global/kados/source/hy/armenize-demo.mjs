// LOCAL demo database copy for the Armenian deck (fv_kados_hy): shop names, people, task titles, visit notes and the
// AI agent's messages back in Armenian. Never run against production (refuses a database with non-demo users).
//   DATABASE_URL=postgres://.../fv_kados_hy node armenize-demo.mjs
import pg from "../../../../../server/node_modules/pg/lib/index.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, p) => pool.query(t, p);
const foreign = (await q("select count(*)::int n from users where email not like '%@kad.demo'")).rows[0].n;
if (foreign) { console.error("Refusing: not the demo database."); process.exit(2); }
const words = [
 ["Car Care","Ավտոտեխսպասարկում"],["Car Wash","Ավտոլվացում"],["Auto Service","Ավտոսերվիս"],["Auto Center","Ավտոկենտրոն"],["Auto Parts","Ավտոպարտս"],
 ["Lubricants","Լուբրիկանտ"],["Oil Change","Յուղման կետ"],["Oil Service","Օյլ Սերվիս"],["Service","Սերվիս"],["Garage","Գարաժ"],["Lube","Լուբ"],["Shop","Շոփ"],["Oil","Յուղ"],["Auto","Ավտո"],
 ["Ararat","Արարատ"],["Sasun","Սասուն"],["Kentron","Կենտրոն"],["Yerevan","Երևան"],["Masis","Մասիս"],["Arabkir","Արաբկիր"],["Shengavit","Շենգավիթ"],["Nor Nork","Նոր Նորք"],
 ["Erebuni","Էրեբունի"],["Malatia","Մալաթիա"],["Davtashen","Դավթաշեն"],["Ajapnyak","Աջափնյակ"],["Kanaker","Քանաքեռ"],["Zeytun","Զեյթուն"],["Avan","Ավան"],["Noragavit","Նորագավիթ"],
 ["Vardanants","Վարդանանք"],["Shirak","Շիրակ"],["Gyumri","Գյումրի"],["Lusavor","Լուսավոր"],["Artsiv","Արծիվ"],["Sevan","Սևան"],["Hrazdan","Հրազդան"],["Aygestan","Այգեստան"],["Nairi","Նաիրի"],["Garni","Գառնի"],
];
const tr = (s) => { for (const [a, b] of words) s = s.split(a).join(b); return s; };
for (const r of (await q("select id,name from customers")).rows) await q("update customers set name=$2 where id=$1", [r.id, tr(r.name)]);
await q("update erp_customer_data e set customer_name=c.name from customers c where c.erp_customer_id=e.erp_customer_id");
await q("update payments p set customer_name_snapshot=c.name from customers c where c.id=p.customer_id");
for (const [e, n] of [["aram", "Մենեջեր Ա"], ["artak", "Մենեջեր Բ"], ["lilit", "Մենեջեր Գ"], ["wh", "Պահեստապետ"], ["driver", "Վարորդ"], ["ceo", "Դեմո տնօրեն"]])
  await q("update users set name=$2, name_hy=$2 where email=$1", [`${e}@kad.demo`, n]);
await q("update payments p set sales_manager_name_snapshot=u.name from users u where u.id=p.sales_manager_id");
const notes = { "Presented the new EDGE range": "Ներկայացվեց EDGE-ի նոր տեսականին", "Order placed": "Պատվեր է ձևակերպվել", "Owner was out, will call back": "Սեփականատերը բացակայում էր, հետ կզանգի", "Left the price list": "Գնացուցակ է տրամադրվել", "Payment collected": "Վճարումը ստացվել է", "Checked the shelf and stock": "Ստուգվեց դարակը և պահեստը" };
for (const [a, b] of Object.entries(notes)) await q("update checkins set note=$2 where note=$1", [a, b]);
for (const r of (await q("select id,title from tasks")).rows) {
  let t = r.title.replace("Collect the overdue debt (oldest invoice past due)", "Հավաքագրիր ժամկետանց պարտքը").replace("Collect the debt", "Հավաքել պարտքը").replace("Visit and leave the price list", "Այցելել և գնացուցակ տալ").replace("Take an order", "Պատվեր ձևակերպել").replace("Call", "Զանգահարել").replace("Check the shelf", "Ստուգել դարակը");
  await q("update tasks set title=$2 where id=$1", [r.id, tr(t)]);
}
await q("delete from vaghinak_messages");
const ins = (u, kind, level, sev, body, ago, extra = {}) => q(
  `insert into vaghinak_messages(user_id,kind,day,level,severity,body,needs_answer,mandatory,choices,shadow,created_at) values ($1,$2,current_date,$3,$4,$5,$6,$7,$8,false, now() - ($9 || ' minutes')::interval)`,
  [u, kind, level, sev, body, !!extra.choices, !!extra.choices, extra.choices ? JSON.stringify(extra.choices) : null, String(ago)]);
await ins(1, "mgmt_brief_issues", 1, "info", "Բարի երեկո, պարոն տնօրեն։ Այսօր ուշադրության արժանի 2 հարց կա՝\n• Մենեջեր Բ-ն ուշացել է 41 րոպե (այս շաբաթ 3-րդ անգամ)\n• Մենեջեր Գ-ն կանգ է առել 9 պլանավորված այցից 4-ից հետո\n\n• Պլանի կատարում՝ 78%\n• Ուշացումներ՝ 2", 2);
await ins(1, "order_waiting_escalation", 1, "info", "Որոշ պատվերներ արդեն շատ երկար են սպասում․ ժամանակն է միջամտել՝\n• Պատվերներ՝ 4\n• Ամենաերկարը՝ 31 ժամ\n• Առաջադրանքը տրվել է վաճառքի տնօրենին, ժամկետը՝ այսօր 18:00", 40);
await ins(1, "debt_promise_broken", 1, "important", "Խոստումը չի կատարվել. Գառնի Ավտոտեխսպասարկումը խոստացել էր վճարել մինչև 27-ը, պարտքը դեռ բաց է։\n• Առաջադրանքը նորից բացվել է Մենեջեր Գ-ի համար\n• Վաճառքի տնօրենը տեղեկացված է", 120);
await ins(2, "cluster_skip", 1, "info", "Ապրես, լավ օր էր։ Վերջին կանգառիցդ 200 մ հեռու 2 պլանավորված խանութ կա՝ Կենտրոն Ավտո և Արաբկիր Սերվիս։ Կմտնե՞ս, մինչև տարածքից դուրս գալը։", 50);
await ins(2, "reorder_hint", 1, "info", "Կենտրոն Ավտոն սովորաբար պատվիրում է 14 օրը մեկ, արդեն 21 օր է անցել։ Էսօր կզանգե՞ս կամ կմտնե՞ս։", 180);
await ins(2, "debt_promise_today", 1, "info", "Գառնի Լուբը խոստացել էր այսօր վճարել։ Այցի ժամանակ հիշեցրու, առաջադրանքը կփակվի ինքնուրույն, երբ վճարումը մտնի։", 300);
await ins(2, "late_start", 1, "info", "Բարի լույս։ Օրը սկսվեց 31 րոպե ուշ։ Եթե պատճառ կար, գրիր ինձ։", 420);
await ins(2, "stopped_early", 2, "important", "2 ժամ 30 րոպե չեք-ին չկա, իսկ 5 պլանավորված այց դեռ մնացել է։ Ի՞նչ է կատարվում։", 1,
  { choices: [{ key: "lunch", label: "Ճաշի ընդմիջում" }, { key: "customer", label: "Հաճախորդի մոտ եմ / սպասում եմ" }, { key: "car", label: "Մեքենայի խնդիր" }, { key: "done", label: "Ավարտեցի օրը" }, { key: "other", label: "Այլ" }] });
await q("update vaghinak_messages set answered_at=null where mandatory");
console.log("armenized", (await q("select count(*)::int n from customers where name ~ '[A-Za-z]{3}' and name !~ 'Castrol'")).rows[0].n, "latin names left");
await pool.end();
