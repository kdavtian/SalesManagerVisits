// Makes the LOCAL demo database deck-ready: English shop names, neutral rep names ("Rep A/B/C"), fake phones, a Castrol-only catalogue,
// English visit notes and task titles, and working-hour timestamps. Never run it against production (it only renames demo rows).
//   DATABASE_URL=postgres://.../fv_deck node anonymize-demo.mjs
import pg from "../../../server/node_modules/pg/lib/index.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const words = [
 ["Ավտոտեխսպասարկում","Car Care"],["Ավտոլվացում","Car Wash"],["Ավտոսերվիս","Auto Service"],["Ավտոկենտրոն","Auto Center"],["Ավտոպարտս","Auto Parts"],
 ["Լուբրիկանտ","Lubricants"],["Յուղման կետ","Oil Change"],["Օյլ Սերվիս","Oil Service"],["Սերվիս","Service"],["Գարաժ","Garage"],["Լուբ","Lube"],["Շոփ","Shop"],["Յուղ","Oil"],["Ավտո","Auto"],
 ["Արարատ","Ararat"],["Սասուն","Sasun"],["Կենտրոն","Kentron"],["Երևան","Yerevan"],["Մասիս","Masis"],["Արաբկիր","Arabkir"],["Շենգավիթ","Shengavit"],["Նոր Նորք","Nor Nork"],
 ["Էրեբունի","Erebuni"],["Մալաթիա","Malatia"],["Դավթաշեն","Davtashen"],["Աջափնյակ","Ajapnyak"],["Քանաքեռ","Kanaker"],["Զեյթուն","Zeytun"],["Ավան","Avan"],["Նորագավիթ","Noragavit"],
 ["Վարդանանք","Vardanants"],["Շիրակ","Shirak"],["Գյումրի","Gyumri"],["Լուսավոր","Lusavor"],["Արծիվ","Artsiv"],["Սևան","Sevan"],["Հրազդան","Hrazdan"],["Այգեստան","Aygestan"],["Նաիրի","Nairi"],["Գառնի","Garni"],
];
const tr = (s) => { for (const [a,b] of words) s = s.split(a).join(b); return s; };
const q = (t, p) => pool.query(t, p);
const foreign = (await q("select count(*)::int n from users where email not like '%@kad.demo'")).rows[0].n;
if (foreign) { console.error("Refusing: this database has users that are not @kad.demo, so it is not the demo database."); process.exit(2); }
for (const r of (await q("select id,name from customers")).rows) await q("update customers set name=$2, phone=case when phone is null then null else '+374000000'||lpad(id::text,2,'0') end where id=$1", [r.id, tr(r.name)]);
await q("update erp_customer_data e set customer_name=c.name from customers c where c.erp_customer_id=e.erp_customer_id");
await q("update payments p set customer_name_snapshot=c.name from customers c where c.id=p.customer_id");
const notes = {"Շնորհանդես՝ նոր ապրանքատեսակ":"Presented the new EDGE range","Պատվեր է ձևակերպվել":"Order placed","Սեփականատերը բացակայում էր":"Owner was out, will call back","Գնացուցակ է տրամադրվել":"Left the price list","Վճարումը ստացվել է":"Payment collected","Ստուգվեց պահեստը":"Checked the shelf and stock"};
for (const [a,b] of Object.entries(notes)) await q("update checkins set note=$2 where note=$1", [a,b]);
for (const r of (await q("select id,title from tasks")).rows) {
  let t = r.title.replace("Հավաքել պարտքը","Collect the debt").replace("Այցելել և գնացուցակ տալ","Visit and leave the price list").replace("Պատվեր ձևակերպել","Take an order").replace("Զանգահարել","Call").replace(/Ստուգել[^՝]*/,"Check the shelf").replace("՝",": ");
  await q("update tasks set title=$2 where id=$1", [r.id, tr(t)]);
}
const reps = [["aram","Rep A","Rep A"],["artak","Rep B","Rep B"],["lilit","Rep C","Rep C"]];
for (const [k,n,h] of reps) await q("update users set name=$2,name_hy=$3 where email=$1", [`${k}@kad.demo`, n, h]);
await q("update payments p set sales_manager_name_snapshot=u.name from users u where u.id=p.sales_manager_id");
// Castrol-only catalogue for the deck
const swap = {"Royal 5W-30 Synthetic 4L":["Castrol Magnatec 10W-40 4L","Magnatec"],"Royal 10W-40 Semi-Synthetic 4L":["Castrol GTX 5W-30 4L","GTX"],"Lotos Quazar 5W-40 4L":["Castrol EDGE 0W-20 4L","EDGE"],"Orlen Platinum Ultor 15W-40 20L":["Castrol Vecton 10W-30 20L","Vecton"]};
for (const [a,[b,f]] of Object.entries(swap)) { await q("update products set name=$2, brand='Castrol', family=$3 where name=$1",[a,b,f]); await q("update order_items set product_name=$2, brand='Castrol' where product_name=$1",[a,b]); }
// every demo login gets the CEO's (demo) password so the screenshot script can sign in as a rep
await q("update users set password_hash=(select password_hash from users where email='ceo@kad.demo') where email like '%@kad.demo'");
// the seed writes the server's local (UTC) hours; Yerevan is UTC+4, so move the history 5 h back into working hours
if (process.env.SHIFT_HOURS !== "0") {
  const h = Number(process.env.SHIFT_HOURS ?? 5);
  await q(`update checkins set timestamp=timestamp-interval '${h} hours', created_at=created_at-interval '${h} hours', ended_at=ended_at-interval '${h} hours'`);
  await q(`update orders set created_at=created_at-interval '${h} hours', updated_at=updated_at-interval '${h} hours'`);
  await q(`update payments set created_at=created_at-interval '${h} hours'`);
}
const left = (await q("select count(*)::int n from customers where name ~ '[Ա-֏]'")).rows[0].n;
const left2 = (await q("select count(*)::int n from products where brand<>'Castrol'")).rows[0].n;
console.log({ armenianNamesLeft: left, nonCastrol: left2 });
await pool.end();
