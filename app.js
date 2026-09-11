/* =========================================================
   نظام إدارة السنتر — app.js
   مزامنة تلقائية مع Firebase: أي تعديل بيتحفظ سحابيًا لوحده
   ========================================================= */

/* ========== 1) أدوات عامة ========== */
var $ = function(id){ return document.getElementById(id); };
var ic = function(n,c){ return '<svg class="ic '+(c||'')+'"><use href="#i-'+n+'"/></svg>'; };
var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
var pad = function(n){ return String(n).padStart(2,'0'); };
var DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
var STATUS_LABEL = {active:'مستمر', frozen:'مجمد', stopped:'وقف'};
var SESSIONS_PER_CYCLE = 8;
var QUIZ_MAX = 20;
var PAGE = 50;
var PAY_CAP = 150;
var ATT_CAP = 400;
var HOME_CAP = 50;
var TITLES = {home:'الرئيسية',reg:'تسجيل طالب جديد',attend:'الحضور والغياب',students:'الطلاب',pay:'الدفع',treasury:'الخزنة',expenses:'المصروفات',assistants:'الاسيستنت',exams:'الامتحانات والدرجات'};

var monthKey = function(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1); };
var dateKey  = function(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
var TODAY = dateKey(new Date());
var CUR_MONTH = monthKey(new Date());

function toLatin(s){
  return String(s)
    .replace(/[٠-٩]/g, function(d){ return String(d.charCodeAt(0)-1632); })
    .replace(/[۰-۹]/g, function(d){ return String(d.charCodeAt(0)-1776); });
}
var money = function(n){ return toLatin((Math.round((n||0)*100)/100).toLocaleString('en-US'))+' ج.م'; };
var parseDate = function(s){ var p=toLatin(s||TODAY).split('-').map(Number); return new Date(p[0],(p[1]||1)-1,p[2]||1); };
var addMonthsDate = function(d,n){ return new Date(d.getFullYear(), d.getMonth()+n, d.getDate()); };
var addDaysDate  = function(d,n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()+n); };
var fmtDate = function(d){ return toLatin(d.getDate()+'/'+(d.getMonth()+1)+'/'+d.getFullYear()); };
var normPhone = function(p){ p=toLatin(p||'').replace(/\D/g,''); if(p.startsWith('00'))p=p.slice(2); if(p.startsWith('0'))p='2'+p; return p; };
var waHref = function(phone,text){ return 'https://wa.me/'+normPhone(phone)+'?text='+encodeURIComponent(text); };
function clampQuiz(v){ var n=parseFloat(toLatin(v)); if(isNaN(n)) return ''; return String(Math.min(Math.max(n,0),QUIZ_MAX)); }
function debounce(fn,ms){ var t; return function(){ var a=arguments,c=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(c,a); },ms); }; }
function emptyAlert(t){ return '<p class="muted" style="text-align:center;padding:12px">'+t+'</p>'; }
function toast(m){ var t=$('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove('show');},2600); }
function printHTML(h){ $('printArea').innerHTML=h; window.print(); }

/* ========== 2) Firebase + مزامنة تلقائية ========== */
var fbAuth=null, fbStore=null, FB_READY=false, CU=null;
var SESSION_TOKEN='tk'+Date.now()+Math.random().toString(36).slice(2);
var CHUNK=800000;
var pushTimer=null, liveUnsub=null, applyingRemote=false, lastCloudTs=0;

function initFirebase(){
  if(typeof firebase==='undefined' || typeof FB_CONFIG==='undefined' || !FB_CONFIG || !FB_CONFIG.apiKey || FB_CONFIG.apiKey.indexOf('PASTE')===0){
    setCloudStatus('وضع محلي — مفيش ربط سحابي');
    return false;
  }
  try{
    if(!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
    fbAuth=firebase.auth(); fbStore=firebase.firestore();
    FB_READY=true; setCloudStatus('متصل بالسحاب ✅');
    return true;
  }catch(e){ setCloudStatus('تعذر الاتصال: '+e.message); return false; }
}
function setCloudStatus(t){ var el=$('cloudStatus'); if(el) el.textContent=t; }

/* رفع تلقائي: أي save() بيعدّي هنا بعد 1.5 ثانية */
function cloudPush(){
  if(!FB_READY||!CU||CU.uid==='local'||applyingRemote) return Promise.resolve();
  var json=JSON.stringify(db);
  var n=Math.ceil(json.length/CHUNK)||1;
  var ref=fbStore.collection('backups').doc('center');
  var batch=fbStore.batch();
  batch.set(ref,{updatedAt:firebase.firestore.FieldValue.serverTimestamp(),chunks:n,size:json.length,by:CU.email,token:SESSION_TOKEN,savedAt:(db._meta&&db._meta.savedAt)||Date.now()});
  for(var i=0;i<n;i++){ batch.set(ref.collection('chunks').doc(String(i)),{i:i,data:json.substr(i*CHUNK,CHUNK)}); }
  return batch.commit().then(function(){
    return ref.collection('chunks').where('i','>=',n).get().then(function(snap){
      if(snap.empty) return;
      var b2=fbStore.batch(); snap.forEach(function(d){ b2.delete(d.ref); }); return b2.commit();
    });
  }).then(function(){
    setCloudStatus('محفوظ سحابيًا ✅ '+new Date().toLocaleTimeString('en-GB'));
  }).catch(function(e){
    setCloudStatus('تعذر الحفظ السحابي: '+e.message);
  });
}
function schedulePush(){
  if(!FB_READY||!CU||CU.uid==='local'||applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer=setTimeout(cloudPush,1500);
}
function applyRemote(obj,ts){
  applyingRemote=true;
  db=obj; db.groups=db.groups||[]; db.counters=db.counters||{receipt:0};
  migrateGroups();
  db.students.forEach(function(s){ if(!s.startDate) s.startDate=(s.startMonth||CUR_MONTH)+'-01'; });
  lsSet(LS,JSON.stringify(db)); buildIndexes();
  applyingRemote=false;
  lastCloudTs=ts||0;
  renderAll();
}
function cloudPull(force){
  if(!FB_READY||!CU||CU.uid==='local') return Promise.resolve();
  var ref=fbStore.collection('backups').doc('center');
  return ref.get().then(function(m){
    if(!m.exists){ return cloudPush(); }
    var d=m.data(); var ts=d.updatedAt?d.updatedAt.toMillis():0;
    if(!force && ts===lastCloudTs) return;
    return ref.collection('chunks').orderBy('i').limit(d.chunks||0).get().then(function(snap){
      var parts=[]; snap.forEach(function(c){ parts[c.data().i]=c.data().data; });
      var obj=JSON.parse(parts.join(''));
      if(!obj.students||!obj.settings) throw new Error('bad');
      applyRemote(obj,ts);
      return true;
    });
  }).catch(function(e){ setCloudStatus('تعذر السحب: '+e.message); });
}
/* استماع لحظي: لو جهاز تاني رفع تعديل، بنسحبه لوحده */
function startLiveSync(){
  if(!FB_READY||!CU||CU.uid==='local'||liveUnsub) return;
  liveUnsub=fbStore.collection('backups').doc('center').onSnapshot(function(snap){
    if(!snap.exists) return;
    var d=snap.data(); var ts=d.updatedAt?d.updatedAt.toMillis():0;
    if(ts===lastCloudTs) return;
    if(d.token===SESSION_TOKEN){ lastCloudTs=ts; return; }
    lastCloudTs=ts;
    cloudPull(true).then(function(changed){ if(changed) toast('تم تحديث البيانات من جهاز تاني ☁️'); });
  },function(){});
}
window.addEventListener('online',function(){ if(FB_READY&&CU&&CU.uid!=='local') cloudPush(); });

/* ========== 3) التخزين المحلي + فهارس ========== */
var LS='markaz_db_v9';
var db=null, curProfileId=null, curSessionsId=null, payTargetId=null;
var mem={};
var IDX={paidPeriod:{},paidSum:{},txBySP:{}};
function lsGet(k){ try{ return window.localStorage.getItem(k); }catch(e){ return (k in mem)?mem[k]:null; } }
function lsSet(k,v){ try{ window.localStorage.setItem(k,v); }catch(e){ mem[k]=v; } }
function lsDel(k){ try{ window.localStorage.removeItem(k); }catch(e){ delete mem[k]; } }
function buildIndexes(){
  IDX={paidPeriod:{},paidSum:{},txBySP:{}};
  db.transactions.forEach(function(t){
    if(t.type==='in'&&t.studentId){
      if(t.period){
        IDX.txBySP[t.studentId+'|'+t.period]=t;
        if(!t.initial) IDX.paidPeriod[t.studentId+'|'+t.period]=true;
      }
      if(!t.initial) IDX.paidSum[t.studentId]=(IDX.paidSum[t.studentId]||0)+t.amount;
    }
  });
}
function save(){
  db._meta=db._meta||{}; db._meta.savedAt=Date.now();
  lsSet(LS,JSON.stringify(db));
  buildIndexes();
  schedulePush(); /* ← هنا السحر: أي حفظ بيترفع سحابيًا تلقائيًا */
}
function seed(){
  return { settings:{centerName:'سنتر مستر اشرف عبدالحليم',teacherName:'مستر اشرف عبدالحليم',monthlyPrice:300,p1:300,p2:350,p3:400,whatsappNumber:'',weak:50,top:85},
    students:[],assistants:[],groups:[],attendance:{},closedDays:[],transactions:[],exams:[],examGrades:{},counters:{receipt:0},currentUser:'مستر اشرف عبدالحليم' };
}
function load(){
  var raw=lsGet(LS);
  try{ db=JSON.parse(raw); }catch(e){ db=null; }
  if(!db||!Array.isArray(db.students)) db=seed();
  db.groups=db.groups||[]; db.counters=db.counters||{receipt:0};
  migrateGroups();
  db.students.forEach(function(s){ if(!s.startDate) s.startDate=(s.startMonth||CUR_MONTH)+'-01'; });
  autoUnfreeze();
  buildIndexes();
}
function migrateGroups(){
  db.groups=db.groups.map(function(g,i){
    if(!g.id) g.id='g'+(i+1)+'_'+Date.now();
    if(!g.sessions) g.sessions=(g.day!=null&&g.day!=='')?[{day:String(g.day),time:toLatin(g.time||'')}] : [];
    return g;
  });
}
function nextReceipt(){ db.counters.receipt=(db.counters.receipt||0)+1; return db.counters.receipt; }

/* ========== 4) مساعدات + حسابات ========== */
function getStudentById(id){ return db.students.find(function(s){return s.id===id;}); }
function getStudentByCode(c){ c=c.toLowerCase(); return db.students.find(function(s){return s.code.toLowerCase()===c;}); }
function activeStudents(){ return db.students.filter(function(s){ return (s.status||'active')==='active'; }); }
function autoUnfreeze(){
  var changed=false;
  db.students.forEach(function(s){
    if(s.status==='frozen'&&s.freezeTo&&TODAY>s.freezeTo){
      var days=Math.round((parseDate(s.freezeTo)-parseDate(s.freezeFrom))/86400000)+1;
      if(days>0){ s.startDate=dateKey(addDaysDate(parseDate(s.startDate),days)); s.startMonth=s.startDate.slice(0,7); }
      s.status='active'; changed=true;
    }
  });
  if(changed) save();
}
function cycleInfo(st){
  var start=parseDate(st.startDate), now=new Date();
  if(st.status==='frozen'&&st.freezeFrom){ var f=addDaysDate(parseDate(st.freezeFrom),-1); if(f<now) now=f; }
  var months=(now.getFullYear()-start.getFullYear())*12+(now.getMonth()-start.getMonth());
  if(now.getDate()<start.getDate()) months--;
  if(months<0) months=0;
  var cStart=addMonthsDate(start,months), cEnd=addDaysDate(addMonthsDate(start,months+1),-1);
  return {index:months,start:cStart,end:cEnd,key:dateKey(cStart)};
}
function priceFor(st){ var s=db.settings; if(st.year==='1')return +s.p1||0; if(st.year==='2')return +s.p2||0; if(st.year==='3')return +s.p3||0; return +s.monthlyPrice||0; }
function sumPaid(s){ return IDX.paidSum[s.id]||0; }
function calcRemaining(s){ return (s.remainingAmount||0)+cycleInfo(s).index*priceFor(s)-sumPaid(s); }
function cyclePayTx(s){ return IDX.txBySP[s.id+'|'+cycleInfo(s).key]||null; }
function paidCurrentCycle(s){ if(IDX.paidPeriod[s.id+'|'+cycleInfo(s).key]) return true; return calcRemaining(s)<=0.0001; }
function attendedInCycle(s){ var ci=cycleInfo(s),a=dateKey(ci.start),b=dateKey(ci.end),n=0; Object.keys(db.attendance).forEach(function(d){ if(d>=a&&d<=b&&db.attendance[d][s.id])n++; }); return n; }
function inFreeze(s,date){ return s.freezeFrom&&date>=s.freezeFrom&&date<=(s.freezeTo||'9999-12-31'); }
function calcAbsence(s){
  var c=0;
  db.closedDays.forEach(function(date){
    if(inFreeze(s,date)) return;
    var st=(s.status||'active');
    if(date.slice(0,7)>=(s.startDate||'').slice(0,7)&&st!=='stopped'&&st!=='frozen'){
      if(!(db.attendance[date]&&db.attendance[date][s.id])) c++;
    }
  });
  return c;
}
function getAbsentDates(s){
  var o=[];
  db.closedDays.forEach(function(date){
    if(inFreeze(s,date)) return;
    var st=(s.status||'active');
    if(date.slice(0,7)>=(s.startDate||'').slice(0,7)&&st!=='stopped'&&st!=='frozen'){
      if(!(db.attendance[date]&&db.attendance[date][s.id])) o.push(date);
    }
  });
  return o.sort();
}
function sessionGrades(s){
  var o=[]; Object.keys(db.attendance).forEach(function(d){ var r=db.attendance[d][s.id]; if(r&&r.score!==undefined&&r.score!=='') o.push({date:d,score:r.score,notes:r.notes||''}); });
  return o.sort(function(a,b){return a.date.localeCompare(b.date);});
}
function examGrades(s){
  var o=[]; db.exams.forEach(function(em){ var g=db.examGrades[em.id]&&db.examGrades[em.id][s.id]; if(g&&g.score!=='') o.push({title:em.title,date:em.date,score:g.score,max:em.maxScore,note:g.note||''}); });
  return o;
}

/* ========== 5) رسائل واتساب ========== */
function waAbsentMsg(s,date){ return 'حضرة ولي أمر الطالب/ة '+s.name+'، نحيط علمكم أن ابنكم/ابنتكم غائب/ة عن حصة اليوم '+date+'. مع تحيات '+db.settings.centerName; }
function waRemindMsg(s){ var ci=cycleInfo(s); return 'حضرة ولي أمر الطالب/ة '+s.name+'، نذكركم بسداد قيمة الدورة من '+fmtDate(ci.start)+' إلى '+fmtDate(ci.end)+' والمتبقي '+money(calcRemaining(s))+'. مع تحيات '+db.settings.centerName; }
function waAbsenceAlert(s){ return 'حضرة ولي أمر الطالب/ة '+s.name+'، عدد غيابات ابنكم/ابنتكم تجاوز 3 مرات. نرجو التواصل. مع تحيات '+db.settings.centerName; }
function waRenewMsg(s){ return 'حضرة ولي أمر الطالب/ة '+s.name+'، أتمّ الطالب حصص الدورة الحالية (8 حصص). نرجو تجديد الدورة. مع تحيات '+db.settings.centerName; }

/* ========== 6) التنقل ========== */
function switchTab(scr){
  document.querySelectorAll('.navbtn,.bnavbtn').forEach(function(b){ b.classList.toggle('active', b.dataset.scr===scr); });
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.toggle('active', s.id==='scr-'+scr); });
  $('pageTitle').textContent=TITLES[scr];
  window.scrollTo({top:0,behavior:'smooth'});
  if(scr==='exams'){ setTimeout(drawQuizChart,0); }
}
document.querySelectorAll('[data-scr]').forEach(function(b){ b.onclick=function(){ switchTab(b.dataset.scr); }; });
function closeOverlay(el){ el.classList.remove('show'); }
document.querySelectorAll('[data-close]').forEach(function(b){ b.onclick=function(){ closeOverlay(b.closest('.overlay')); }; });
document.querySelectorAll('.overlay').forEach(function(o){ o.addEventListener('click',function(e){ if(e.target===o) closeOverlay(o); }); });
document.addEventListener('keydown',function(e){ if(e.key==='Escape') document.querySelectorAll('.overlay.show').forEach(closeOverlay); });

/* ========== 7) الرئيسية ========== */
function alertRow(s,badge,waText){
  return '<div class="att-row"><div class="att-info"><span class="code">'+s.code+'</span><span class="'+(calcAbsence(s)>=3?'red':'')+'">'+esc(s.name)+'</span>'+badge+'</div>'+
    (s.parentPhone&&waText?'<a class="btn sm wa" target="_blank" rel="noopener" href="'+waHref(s.parentPhone,waText)+'">'+ic('send','sm')+'واتساب</a>':'')+'</div>';
}
function moreNote(n){ return n>0?'<p class="muted" style="text-align:center;padding:8px">+ '+toLatin(n)+' كمان (استخدم البحث/الفلاتر)</p>':''; }
function renderHome(){
  var recs=db.attendance[TODAY]||{}, act=activeStudents();
  var present=act.filter(function(s){return recs[s.id];}).length;
  var absent=act.filter(function(s){return !recs[s.id];}).length;
  var mIn=db.transactions.filter(function(t){return t.type==='in'&&t.date.slice(0,7)===CUR_MONTH;}).reduce(function(a,t){return a+t.amount;},0);
  var mOut=db.transactions.filter(function(t){return t.type==='out'&&t.date.slice(0,7)===CUR_MONTH;}).reduce(function(a,t){return a+t.amount;},0);
  $('hPresent').textContent=toLatin(present); $('hAbsent').textContent=toLatin(absent);
  $('hNet').textContent=money(mIn-mOut);
  $('hUnpaid').textContent=toLatin(act.filter(function(s){return !paidCurrentCycle(s);}).length);
  $('homeGroups').innerHTML=groupsToday().map(function(g){return '<span class="badge b-in">'+esc(g.name)+' — '+esc(g.time)+'</span>';}).join(' ')||'مفيش مجموعات النهاردة';
  var a1=act.filter(function(s){return calcAbsence(s)>=3;});
  var a2=act.filter(function(s){return !paidCurrentCycle(s)&&cycleInfo(s).index>=1;});
  var a3=act.filter(function(s){var d=Math.round((cycleInfo(s).end-parseDate(TODAY))/86400000);return d>=0&&d<=3;});
  var a4=act.filter(function(s){return attendedInCycle(s)>=SESSIONS_PER_CYCLE;});
  $('alAbsence').innerHTML=a1.slice(0,HOME_CAP).map(function(s){return alertRow(s,'<span class="badge b-bad">غياب '+toLatin(calcAbsence(s))+'</span>',waAbsenceAlert(s));}).join('')+moreNote(a1.length-HOME_CAP)||emptyAlert('مفيش تنبيهات غياب');
  $('alUnpaidDone').innerHTML=a2.slice(0,HOME_CAP).map(function(s){return alertRow(s,'<span class="badge b-bad">عليه '+money(calcRemaining(s))+'</span>',waRemindMsg(s));}).join('')+moreNote(a2.length-HOME_CAP)||emptyAlert('كل اللي خلصت دورته دافع');
  $('alEnding').innerHTML=a3.slice(0,HOME_CAP).map(function(s){var d=Math.round((cycleInfo(s).end-parseDate(TODAY))/86400000);return alertRow(s,'<span class="badge b-warn">فاضل '+toLatin(d)+' يوم</span>',waRemindMsg(s));}).join('')+moreNote(a3.length-HOME_CAP)||emptyAlert('مفيش دورات هتخلص قريب');
  $('alFull').innerHTML=a4.slice(0,HOME_CAP).map(function(s){return alertRow(s,'<span class="badge b-ok">أتمّ 8 حصص</span>',waRenewMsg(s));}).join('')+moreNote(a4.length-HOME_CAP)||emptyAlert('مفيش حد خلّص 8 حصص لسه');
}

/* ========== 8) تسجيل طالب ========== */
$('rgStart').value=TODAY;
$('btnReg').onclick=function(){
  var name=$('rgName').value.trim(), code=$('rgCode').value.trim();
  if(!name){toast('اكتب اسم الطالب');return;}
  if(!code){toast('اكتب كود الطالب');return;}
  if(db.students.some(function(s){return s.code.toLowerCase()===code.toLowerCase();})){toast('الكود مستخدم قبل كده');return;}
  var startDate=$('rgStart').value||TODAY;
  var paid=+toLatin($('rgPaid').value)||0;
  var remain=+toLatin($('rgRemain').value)||0;
  var st={ id:'s'+Date.now(), code:code, name:name, group:$('rgGroup').value, year:$('rgYear').value, type:$('rgType').value,
    school:$('rgSchool').value.trim(), startDate:startDate, startMonth:startDate.slice(0,7),
    paidAmount:paid, remainingAmount:remain, phone:toLatin($('rgPhone').value.trim()), parentPhone:toLatin($('rgParent').value.trim()),
    notes:$('rgNotes').value.trim(), status:'active', createdAt:new Date().toISOString() };
  db.students.push(st);
  if(paid>0){ var ci=cycleInfo(st); db.transactions.push({id:'t'+Date.now(),date:TODAY,month:TODAY.slice(0,7),period:ci.key,type:'in',category:'فلوس درس',amount:paid,note:'دفع عند التسجيل',studentId:st.id,studentName:st.name,initial:true,receiptNo:nextReceipt(),by:db.currentUser||''}); }
  save();
  ['rgName','rgCode','rgSchool','rgPaid','rgRemain','rgPhone','rgParent','rgNotes'].forEach(function(id){$(id).value='';});
  $('rgYear').value=''; $('rgType').value=''; $('rgGroup').value=''; $('rgStart').value=TODAY;
  renderAll(); toast('تم تسجيل الطالب: '+name);
};

/* ========== 9) الحضور والغياب ========== */
$('atDate').value=TODAY;
$('atDate').addEventListener('change', renderAttendance);
$('atGroup').addEventListener('change', renderAttendance);
function filteredActive(){
  var g=($('atGroup').value||'').trim();
  return activeStudents().filter(function(s){ return !g||(s.group||'').trim()===g; });
}
function refreshExamOptions(){
  var cur=$('atExam').value;
  $('atExam').innerHTML='<option value="">— اختر الامتحان —</option>'+db.exams.map(function(e){return '<option value="'+e.id+'">'+esc(e.title)+'</option>';}).join('');
  if(cur&&db.exams.some(function(e){return e.id===cur;})) $('atExam').value=cur;
}
$('btnAttend').onclick=function(){
  var code=$('atCode').value.trim(), date=$('atDate').value||TODAY;
  if(!code){toast('اكتب كود الطالب');return;}
  var st=getStudentByCode(code);
  if(!st){toast('مفيش طالب بالكود ده');return;}
  var gf=($('atGroup').value||'').trim();
  if(gf&&(st.group||'').trim()!==gf) toast('تنبيه: '+st.name+' مش في المجموعة المختارة — اتسجل على أي حال');
  db.attendance[date]=db.attendance[date]||{};
  db.attendance[date][st.id]={score:clampQuiz($('atScore').value),notes:$('atNotes').value.trim(),at:new Date().toISOString(),by:db.currentUser||''};
  var exId=$('atExam').value, exScore=clampQuiz($('atExamScore').value);
  if(exId&&exScore!==''){
    var em=db.exams.find(function(e){return e.id===exId;});
    if(em){ db.examGrades[exId]=db.examGrades[exId]||{}; var on=(db.examGrades[exId][st.id]&&db.examGrades[exId][st.id].note)||''; db.examGrades[exId][st.id]={score:Math.min(Math.max(+exScore,0),em.maxScore),note:on}; }
  }
  save();
  $('atCode').value=''; $('atScore').value=''; $('atNotes').value=''; $('atExamScore').value='';
  $('atCode').focus();
  renderAttendance(); renderHome(); renderQuizStats();
  toast('تم تسجيل حضور: '+st.name);
};
function undoAttend(date,sid){ if(db.attendance[date]) delete db.attendance[date][sid]; save(); renderAttendance(); renderStudents(); renderExamStats(); renderHome(); }
function renderAttendance(){
  var date=$('atDate').value||TODAY, recs=db.attendance[date]||{}, list=filteredActive();
  $('atTodayGroups').innerHTML=groupsToday().map(function(g){return '<span class="badge b-in">'+esc(g.name)+' — '+esc(g.time)+'</span>';}).join(' ')||'مفيش مجموعات النهاردة';
  var present=list.filter(function(s){return recs[s.id];});
  var absent=list.filter(function(s){return !recs[s.id];});
  var truncated=list.length>ATT_CAP;
  var view=truncated?list.slice(0,ATT_CAP):list;
  var vPresent=view.filter(function(s){return recs[s.id];});
  var vAbsent=view.filter(function(s){return !recs[s.id];});
  $('atPresentList').innerHTML=vPresent.map(function(s){
    var r=recs[s.id], sc=(r.score!==undefined&&r.score!=='')?(r.score+'/20'):'—';
    return '<div class="att-row"><div class="att-info"><span class="code">'+s.code+'</span><b>'+esc(s.name)+'</b><span class="badge b-in">كويز: '+esc(sc)+'</span>'+(r.notes?'<span class="muted">'+esc(r.notes)+'</span>':'')+'</div><button class="iconbtn del" onclick="undoAttend(\''+date+'\',\''+s.id+'\')">'+ic('x','sm')+'</button></div>';
  }).join('')||emptyAlert('لسه مفيش حضور مسجل');
  $('atAbsentList').innerHTML=vAbsent.map(function(s){
    var t=calcAbsence(s);
    return '<div class="att-row"><div class="att-info"><span class="code">'+s.code+'</span><span class="'+(t>=3?'red':'')+'">'+esc(s.name)+'</span><span class="badge b-bad">غياب</span><span class="muted">إجمالي: '+toLatin(t)+'</span></div></div>';
  }).join('')||emptyAlert('كل طلاب الفلتر حاضرين');
  var closed=db.closedDays.indexOf(date)>=0;
  $('atSummary').innerHTML='التاريخ: <b>'+date+'</b> | المجموعة: <b>'+($('atGroup').value||'الكل')+'</b> | حاضر: <b class="pos">'+toLatin(present.length)+'</b> | غياب: <b class="neg">'+toLatin(absent.length)+'</b>'+(truncated?' | <span class="badge b-warn">عرض أول '+toLatin(ATT_CAP)+' — استخدم فلتر المجموعة</span>':'')+(closed?' | <span class="badge b-mute">اليوم مقفول</span>':'');
  $('btnCloseDay').disabled=closed;
}
$('btnCloseDay').onclick=function(){
  var date=$('atDate').value||TODAY;
  if(db.closedDays.indexOf(date)>=0){toast('اليوم مقفول قبل كده');return;}
  if(!confirm('غلق اليوم هيثبت الغياب لكل اللي مش مسجلين. متأكد؟'))return;
  db.closedDays.push(date); save(); renderAttendance(); renderStudents(); renderHome(); toast('تم غلق اليوم');
};
$('btnWaAbsent').onclick=function(){
  var date=$('atDate').value||TODAY, recs=db.attendance[date]||{};
  var abs=filteredActive().filter(function(s){return !recs[s.id];});
  if(!abs.length){toast('مفيش غايبين');return;}
  $('waList').innerHTML=abs.map(function(s){
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid #f1f5f9"><span style="font-weight:700">'+esc(s.name)+'<br><span class="muted">'+(s.parentPhone||'بدون رقم')+'</span></span>'+
      (s.parentPhone?'<a class="btn sm wa" target="_blank" rel="noopener" href="'+waHref(s.parentPhone,waAbsentMsg(s,date))+'">'+ic('send','sm')+'إرسال</a>':'<span class="badge b-mute">لا رقم</span>')+'</div>';
  }).join('');
  $('mWa').classList.add('show');
};

/* ========== 10) الطلاب (ترقيم صفحات) ========== */
var stuPage=0;
$('stSearch').addEventListener('input', debounce(function(){ stuPage=0; renderStudents(); },200));
$('stYearFilter').onchange=function(){ stuPage=0; renderStudents(); };
$('stTypeFilter').onchange=function(){ stuPage=0; renderStudents(); };
$('stuPrev').onclick=function(){ if(stuPage>0){ stuPage--; renderStudents(); } };
$('stuNext').onclick=function(){ stuPage++; renderStudents(); };
function renderStudents(){
  var q=$('stSearch').value.trim().toLowerCase(), yf=$('stYearFilter').value, tf=$('stTypeFilter').value;
  var list=db.students.filter(function(s){
    var mq=!q||s.name.toLowerCase().indexOf(q)>=0||s.code.toLowerCase().indexOf(q)>=0;
    return mq&&(!yf||String(s.year)===yf)&&(!tf||s.type===tf);
  });
  var pages=Math.max(1,Math.ceil(list.length/PAGE));
  if(stuPage>=pages) stuPage=pages-1;
  if(stuPage<0) stuPage=0;
  var rows=list.slice(stuPage*PAGE, stuPage*PAGE+PAGE);
  $('stBody').innerHTML=rows.map(function(s){
    var rem=calcRemaining(s), abs=calcAbsence(s);
    return '<tr><td style="font-weight:700">'+s.code+'</td><td class="'+(abs>=3?'red':'')+'">'+esc(s.name)+'</td><td class="muted">'+(s.year||'—')+'</td><td class="muted">'+(s.type||'—')+'</td><td class="muted">'+esc(s.group||'—')+'</td>'+
      '<td><span class="badge '+(rem>0?'b-bad':'b-ok')+'">'+(rem>0?'عليه '+money(rem):'خالص')+'</span></td>'+
      '<td><span class="badge '+(abs>=3?'b-bad':'b-mute')+'">'+toLatin(abs)+'</span></td>'+
      '<td style="white-space:nowrap"><button class="iconbtn" onclick="openEdit(\''+s.id+'\')">'+ic('edit','sm')+'</button> <button class="btn sm primary" onclick="openProfile(\''+s.id+'\')">'+ic('search','sm')+' عرض</button></td></tr>';
  }).join('')||'<tr><td colspan="8" class="muted" style="text-align:center;padding:26px">مفيش طلاب — سجل أول طالب</td></tr>';
  $('stuInfo').textContent='صفحة '+toLatin(stuPage+1)+' من '+toLatin(pages)+' — '+toLatin(list.length)+' طالب';
  $('stuPrev').disabled=stuPage===0;
  $('stuNext').disabled=stuPage>=pages-1;
}
function field(l,v){ return '<div class="kv"><span>'+l+'</span><b>'+v+'</b></div>'; }
function openProfile(id){
  var s=getStudentById(id); if(!s)return; curProfileId=id;
  var ci=cycleInfo(s), abs=calcAbsence(s), rem=calcRemaining(s), att=attendedInCycle(s);
  var sg=sessionGrades(s), eg=examGrades(s), ad=getAbsentDates(s);
  var h='<h3>'+ic('users')+' ملف الطالب: '+esc(s.name)+'</h3><div class="grid2" style="gap:0 18px">';
  h+=field('الكود',s.code)+field('السنة',s.year||'—')+field('النوع',s.type||'—')+field('المجموعة',s.group||'—');
  h+=field('المدرسة',s.school||'—')+field('جه من',fmtDate(parseDate(s.startDate)));
  h+=field('الدورة الحالية',fmtDate(ci.start)+' → '+fmtDate(ci.end));
  h+=field('حضر في الدورة','<span class="'+(att>=SESSIONS_PER_CYCLE?'green':'')+'">'+toLatin(att)+' / '+toLatin(SESSIONS_PER_CYCLE)+' حصة</span>');
  if(s.status==='frozen'&&s.freezeFrom) h+=field('مجمد من → إلى',s.freezeFrom+' → '+(s.freezeTo||'مستمر'));
  h+=field('رقم الطالب',s.phone||'—')+field('رقم ولي الأمر',s.parentPhone||'—');
  h+=field('دفع مبدئي',money(s.paidAmount||0));
  h+=field('المتبقي الآن','<span class="'+(rem>0?'neg':'pos')+'" style="font-weight:800">'+money(rem)+'</span>');
  h+=field('حالة الدفع',paidCurrentCycle(s)?'<span class="badge b-ok">دافع الدورة</span>':'<span class="badge b-bad">مش دافع</span>');
  h+=field('إجمالي الغياب','<span class="'+(abs>=3?'red':'')+'">'+toLatin(abs)+'</span>')+'</div>';
  if(s.notes) h+='<div class="kv"><span>ملاحظات</span><b>'+esc(s.notes)+'</b></div>';
  h+='<h4>تواريخ الغياب</h4>'+(ad.length?'<p class="muted">'+ad.join('، ')+'</p>':'<p class="muted">لا يوجد</p>');
  h+='<h4>كويز الحصص (من 20)</h4>'+(sg.length?'<div class="table-wrap"><table><tr><th>التاريخ</th><th>الدرجة</th><th>ملاحظات</th></tr>'+sg.map(function(g){return '<tr><td>'+g.date+'</td><td>'+esc(g.score)+' / 20</td><td>'+esc(g.notes)+'</td></tr>';}).join('')+'</table></div>':'<p class="muted">لا يوجد</p>');
  h+='<h4>الامتحانات الشاملة</h4>'+(eg.length?'<div class="table-wrap"><table><tr><th>الامتحان</th><th>الدرجة</th><th>ملاحظات</th></tr>'+eg.map(function(g){return '<tr><td>'+esc(g.title)+'</td><td>'+toLatin(g.score)+'/'+toLatin(g.max)+'</td><td>'+esc(g.note)+'</td></tr>';}).join('')+'</table></div>':'<p class="muted">لا يوجد</p>');
  h+='<div class="row"><button class="btn ghost" onclick="openEdit(\''+s.id+'\')">'+ic('edit','sm')+' تعديل البيانات</button>';
  h+='<button class="btn ghost" onclick="openSessions(\''+s.id+'\')">'+ic('calendar-check','sm')+' الحصص والكويزات</button>';
  h+='<button class="btn ghost" onclick="printStatement(\''+s.id+'\')">'+ic('print','sm')+' كشف حساب</button>';
  h+='<button class="btn danger" onclick="delStudent(\''+s.id+'\')">'+ic('trash','sm')+' حذف</button>';
  h+='<button class="btn ghost" data-close>إغلاق</button></div>';
  $('profileBox').innerHTML=h;
  $('mProfile').classList.add('show');
  $('mProfile').querySelectorAll('[data-close]').forEach(function(b){ b.onclick=function(){ closeOverlay($('mProfile')); }; });
}
function groupOptions(sel){
  var names=db.groups.map(function(g){return g.name;});
  if(sel&&names.indexOf(sel)<0) names.push(sel);
  return '<option value="">— بدون مجموعة —</option>'+names.map(function(n){return '<option value="'+esc(n)+'"'+(n===sel?' selected':'')+'>'+esc(n)+'</option>';}).join('');
}
function openEdit(id){
  var s=getStudentById(id); if(!s)return;
  $('edId').value=s.id; $('edName').value=s.name; $('edCode').value=s.code;
  $('edGroup').innerHTML=groupOptions(s.group||'');
  $('edYear').value=s.year||''; $('edType').value=s.type||'';
  $('edStart').value=s.startDate||TODAY; $('edPaid').value=s.paidAmount||0; $('edRemain').value=s.remainingAmount||0;
  $('edSchool').value=s.school||''; $('edPhone').value=s.phone||''; $('edParent').value=s.parentPhone||'';
  $('edNotes').value=s.notes||''; $('edStatus').value=s.status||'active';
  $('edFreezeFrom').value=s.freezeFrom||''; $('edFreezeTo').value=s.freezeTo||'';
  $('mEdit').classList.add('show');
}
$('btnSaveEdit').onclick=function(){
  var id=$('edId').value, s=getStudentById(id); if(!s)return;
  var code=$('edCode').value.trim();
  if(!code){toast('الكود مطلوب');return;}
  if(db.students.some(function(x){return x.id!==id&&x.code.toLowerCase()===code.toLowerCase();})){toast('الكود مستخدم لطالب تاني');return;}
  s.name=$('edName').value.trim()||s.name; s.code=code; s.group=$('edGroup').value; s.year=$('edYear').value; s.type=$('edType').value;
  s.startDate=$('edStart').value||s.startDate; s.startMonth=s.startDate.slice(0,7);
  s.paidAmount=+toLatin($('edPaid').value)||0; s.remainingAmount=+toLatin($('edRemain').value)||0;
  s.school=$('edSchool').value.trim(); s.phone=toLatin($('edPhone').value.trim()); s.parentPhone=toLatin($('edParent').value.trim());
  s.notes=$('edNotes').value.trim(); s.status=$('edStatus').value;
  s.freezeFrom=$('edFreezeFrom').value; s.freezeTo=$('edFreezeTo').value;
  var initTx=db.transactions.find(function(t){return t.studentId===id&&t.initial;});
  if(s.paidAmount>0){
    if(initTx) initTx.amount=s.paidAmount;
    else{ var ci=cycleInfo(s); db.transactions.push({id:'t'+Date.now(),date:TODAY,month:TODAY.slice(0,7),period:ci.key,type:'in',category:'فلوس درس',amount:s.paidAmount,note:'دفع عند التسجيل',studentId:id,studentName:s.name,initial:true,receiptNo:nextReceipt(),by:db.currentUser||''}); }
  }else if(initTx){ db.transactions=db.transactions.filter(function(t){return t.id!==initTx.id;}); }
  save(); closeOverlay($('mEdit')); autoUnfreeze(); renderAll();
  if($('mProfile').classList.contains('show')&&curProfileId===id) openProfile(id);
  toast('تم حفظ التعديلات');
};

/* ========== 11) تعديل الحصص والكويزات ========== */
function openSessions(id){
  curSessionsId=id; var s=getStudentById(id); if(!s)return;
  $('sesTitle').innerHTML=ic('calendar-check')+' تعديل حصص وكويزات: '+esc(s.name);
  var dates=Object.keys(db.attendance).filter(function(d){return db.attendance[d][id];}).sort().reverse();
  $('sesList').innerHTML=dates.map(function(d){
    var r=db.attendance[d][id];
    return '<div class="att-row"><div class="att-info"><span class="code">'+d+'</span><input type="number" min="0" max="20" style="width:90px" value="'+esc(r.score===undefined?'':r.score)+'" onchange="setSesScore(\''+id+'\',\''+d+'\',this.value)"><input type="text" style="width:150px" value="'+esc(r.notes||'')+'" onchange="setSesNotes(\''+id+'\',\''+d+'\',this.value)" placeholder="ملاحظة"></div><button class="iconbtn del" onclick="delSession(\''+id+'\',\''+d+'\')">'+ic('trash','sm')+'</button></div>';
  }).join('')||emptyAlert('مفيش حصص — ضيف من تحت');
  $('sesDate').value=TODAY; $('sesScore').value=''; $('sesNotes').value='';
  $('mSessions').classList.add('show');
}
function afterSessionEdit(){ renderStudents(); renderAttendance(); renderExamStats(); renderPayment(); renderHome(); if($('mProfile').classList.contains('show')&&curProfileId) openProfile(curProfileId); }
function setSesScore(id,d,v){ db.attendance[d][id].score=clampQuiz(v); save(); afterSessionEdit(); }
function setSesNotes(id,d,v){ db.attendance[d][id].notes=v; save(); afterSessionEdit(); }
function delSession(id,d){ if(!confirm('حذف الحصة/الكويز؟'))return; delete db.attendance[d][id]; save(); openSessions(id); afterSessionEdit(); toast('تم حذف الحصة'); }
$('btnAddSession').onclick=function(){
  var id=curSessionsId; if(!id)return;
  var d=$('sesDate').value||TODAY;
  db.attendance[d]=db.attendance[d]||{};
  db.attendance[d][id]={score:clampQuiz($('sesScore').value),notes:$('sesNotes').value.trim(),at:new Date().toISOString(),by:db.currentUser||''};
  save(); openSessions(id); afterSessionEdit(); toast('تم إضافة الحصة');
};
function delStudent(id){
  if(!confirm('هتحذف الطالب وكل بياناته. متأكد؟'))return;
  db.students=db.students.filter(function(s){return s.id!==id;});
  db.transactions=db.transactions.filter(function(t){return t.studentId!==id;});
  Object.keys(db.attendance).forEach(function(d){ if(db.attendance[d][id]) delete db.attendance[d][id]; });
  Object.keys(db.examGrades).forEach(function(e){ if(db.examGrades[e][id]) delete db.examGrades[e][id]; });
  save(); closeOverlay($('mProfile')); renderAll(); toast('تم حذف الطالب');
}

/* ========== 12) الدفع ========== */
var payLimPaid=PAY_CAP, payLimUnpaid=PAY_CAP;
$('paySearch').addEventListener('input', debounce(function(){ payLimPaid=PAY_CAP; payLimUnpaid=PAY_CAP; renderPayment(); },200));
function payMore(w){ if(w==='paid') payLimPaid+=PAY_CAP; else payLimUnpaid+=PAY_CAP; renderPayment(); }
function renderPayment(){
  var q=$('paySearch').value.trim().toLowerCase();
  var list=db.students.filter(function(s){return (s.status||'active')!=='stopped';}).filter(function(s){return !q||s.name.toLowerCase().indexOf(q)>=0||s.code.toLowerCase().indexOf(q)>=0;});
  var paid=[],unpaid=[];
  list.forEach(function(s){ (paidCurrentCycle(s)?paid:unpaid).push(s); });
  $('payInfo').innerHTML='الدفع عن <b>الدورة الحالية</b> (من تاريخ بدء كل طالب). الدورة = <b>'+toLatin(SESSIONS_PER_CYCLE)+' حصص</b>. دافعين: <b class="green">'+toLatin(paid.length)+'</b> | مش دافعين: <b class="red">'+toLatin(unpaid.length)+'</b>';
  var pv=paid.slice(0,payLimPaid);
  $('payPaidList').innerHTML=pv.map(function(s){
    var t=cyclePayTx(s);
    return '<div class="att-row"><div class="att-info"><span class="code">'+s.code+'</span><span class="green">'+esc(s.name)+'</span><span class="badge b-ok">دافع</span><span class="muted">'+(t?money(t.amount)+' — '+t.date:'')+'</span></div>'+
      '<div style="display:flex;gap:6px">'+(t?'<button class="iconbtn" title="إيصال" onclick="printReceipt(\''+t.id+'\')">'+ic('print','sm')+'</button><button class="iconbtn" title="تعديل" onclick="editPay(\''+t.id+'\')">'+ic('edit','sm')+'</button><button class="iconbtn del" title="إلغاء" onclick="undoPay(\''+t.id+'\')">'+ic('x','sm')+'</button>':'')+'</div></div>';
  }).join('')+(paid.length>pv.length?'<div class="row"><button class="btn ghost sm block" onclick="payMore(\'paid\')">عرض '+toLatin(PAY_CAP)+' كمان ('+toLatin(paid.length-pv.length)+' متبقي)</button></div>':'')||emptyAlert('مفيش دافعين هنا');
  var uv=unpaid.slice(0,payLimUnpaid);
  $('payUnpaidList').innerHTML=uv.map(function(s){
    return '<div class="att-row"><div class="att-info"><span class="code">'+s.code+'</span><span class="red">'+esc(s.name)+'</span><span class="badge b-bad">مش دافع</span><span class="muted">عليه: '+money(calcRemaining(s))+'</span></div>'+
      '<div style="display:flex;gap:6px"><button class="btn sm primary" onclick="payNow(\''+s.id+'\')">'+ic('dollar','sm')+'دفع</button>'+(s.parentPhone?'<a class="btn sm wa" target="_blank" rel="noopener" href="'+waHref(s.parentPhone,waRemindMsg(s))+'">'+ic('send','sm')+'</a>':'')+'</div></div>';
  }).join('')+(unpaid.length>uv.length?'<div class="row"><button class="btn ghost sm block" onclick="payMore(\'unpaid\')">عرض '+toLatin(PAY_CAP)+' كمان ('+toLatin(unpaid.length-uv.length)+' متبقي)</button></div>':'')||emptyAlert('كل الناس دافعة');
}
function payNow(id){
  var s=getStudentById(id); if(!s)return;
  if(cyclePayTx(s)){toast('الدورة دي مدفوعة');return;}
  payTargetId=id; var ci=cycleInfo(s);
  $('payName').textContent=s.code+' — '+s.name;
  $('payCycle').textContent=fmtDate(ci.start)+' → '+fmtDate(ci.end);
  $('payAmount').value=priceFor(s); $('payNote').value='';
  $('mPay').classList.add('show');
  setTimeout(function(){$('payAmount').focus();},60);
}
$('btnConfirmPay').onclick=function(){
  var id=payTargetId; if(!id)return;
  var s=getStudentById(id); if(!s)return;
  var amt=+toLatin($('payAmount').value);
  if(!amt||amt<=0){toast('مبلغ غير صحيح');return;}
  var ci=cycleInfo(s);
  db.transactions.push({id:'t'+Date.now(),date:TODAY,month:TODAY.slice(0,7),period:ci.key,type:'in',category:'فلوس درس',amount:amt,note:$('payNote').value.trim()||'دفع دورة',studentId:id,studentName:s.name,receiptNo:nextReceipt(),by:db.currentUser||''});
  save(); closeOverlay($('mPay'));
  renderPayment(); renderTreasury(); renderStudents(); renderExpenses(); renderHome();
  toast('تم تسجيل دفع: '+s.name);
};
function editPay(tid){ var t=db.transactions.find(function(x){return x.id===tid;}); if(!t)return; var v=prompt('المبلغ الجديد:',t.amount); if(v===null)return; v=+toLatin(v); if(!v||v<=0){toast('مبلغ غير صحيح');return;} t.amount=v; save(); renderPayment(); renderTreasury(); renderStudents(); renderExpenses(); toast('تم التعديل'); }
function undoPay(tid){ if(!confirm('إلغاء الدفع؟'))return; db.transactions=db.transactions.filter(function(t){return t.id!==tid;}); save(); renderPayment(); renderTreasury(); renderStudents(); renderExpenses(); renderHome(); toast('تم إلغاء الدفع'); }

/* ========== 13) إيصال + كشف حساب ========== */
function printReceipt(tid){
  var t=db.transactions.find(function(x){return x.id===tid;}); if(!t)return;
  printHTML('<div style="text-align:center;border:2px solid #333;padding:18px;border-radius:10px;max-width:420px;margin:auto"><h2>'+db.settings.centerName+'</h2><p>إيصال تحصيل رقم <b>'+toLatin(t.receiptNo||'—')+'</b></p><hr><table style="width:100%"><tr><td>التاريخ</td><td><b>'+t.date+'</b></td></tr><tr><td>الطالب</td><td><b>'+esc(t.studentName||'')+'</b></td></tr><tr><td>الدورة</td><td><b>'+(t.period||'')+'</b></td></tr><tr><td>المبلغ</td><td><b>'+money(t.amount)+'</b></td></tr><tr><td>ملاحظات</td><td><b>'+esc(t.note||'')+'</b></td></tr><tr><td>المحصّل</td><td><b>'+esc(t.by||'')+'</b></td></tr></table><p style="margin-top:10px;font-size:12px">شكرًا لتعاملكم معنا</p></div>');
}
function printStatement(sid){
  var s=getStudentById(sid); if(!s)return;
  var txs=db.transactions.filter(function(t){return t.type==='in'&&t.studentId===sid;}).sort(function(a,b){return a.date.localeCompare(b.date);});
  var total=txs.reduce(function(a,t){return a+t.amount;},0);
  printHTML('<h2>'+db.settings.centerName+' — كشف حساب</h2><h3>'+esc(s.name)+' ('+s.code+')</h3><table><tr><th>التاريخ</th><th>الدورة</th><th>المبلغ</th><th>ملاحظات</th></tr>'+txs.map(function(t){return '<tr><td>'+t.date+'</td><td>'+(t.period||'')+'</td><td>'+money(t.amount)+'</td><td>'+esc(t.note||'')+'</td></tr>';}).join('')+'</table><p style="margin-top:12px"><b>إجمالي المدفوع:</b> '+money(total)+' | <b>المتبقي الحالي:</b> '+money(calcRemaining(s))+'</p><p style="margin-top:24px">توقيع السنتر: ....................</p>');
}

/* ========== 14) الخزنة ========== */
$('trMonth').value=CUR_MONTH; $('trMonth').onchange=renderTreasury;
function renderTreasury(){
  var m=$('trMonth').value||CUR_MONTH;
  var tx=db.transactions.filter(function(t){return t.date.slice(0,7)===m;});
  var tin=tx.filter(function(t){return t.type==='in';}).reduce(function(a,t){return a+t.amount;},0);
  var tout=tx.filter(function(t){return t.type==='out';}).reduce(function(a,t){return a+t.amount;},0);
  $('trIn').textContent=money(tin); $('trOut').textContent=money(tout); $('trNet').textContent=money(tin-tout);
  $('trNet').className=(tin-tout>=0?'pos':'neg');
  var cats={}; tx.filter(function(t){return t.type==='out';}).forEach(function(t){ cats[t.category]=(cats[t.category]||0)+t.amount; });
  $('trBreakdown').innerHTML=Object.keys(cats).map(function(c){return '<div class="kv"><span>'+c+'</span><b class="neg">'+money(cats[c])+'</b></div>';}).join('')||'<p class="muted">مفيش مصروفات</p>';
  $('trList').innerHTML=tx.slice().reverse().slice(0,30).map(function(t){
    var det=(t.note||'')+(t.studentName?' — '+t.studentName:'')+(t.assistantName?' — '+t.assistantName:'');
    return '<tr><td class="muted">'+t.date+'</td><td>'+(t.type==='in'?'<span class="badge b-ok">داخل</span>':'<span class="badge b-bad">خارج</span>')+'</td><td>'+t.category+'</td><td class="muted">'+det+'</td><td style="font-weight:700">'+money(t.amount)+'</td></tr>';
  }).join('')||'<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">مفيش عمليات</td></tr>';
}

/* ========== 15) المصروفات ========== */
$('exDate').value=TODAY; $('exFilterMonth').value=CUR_MONTH;
$('exFilterMonth').onchange=renderExpenses; $('exType').onchange=renderExpForm; $('exCategory').onchange=toggleExpFields;
function renderExpForm(){
  var t=$('exType').value, c=$('exCategory');
  if(t==='in') c.innerHTML='<option value="فلوس درس">فلوس درس</option><option value="دخل أخرى">دخل أخرى</option>';
  else c.innerHTML='<option value="مرتب اسيستنت">مرتب اسيستنت</option><option value="إيجار">إيجار</option><option value="كهرباء">كهرباء</option><option value="طباعة">طباعة</option><option value="مصروف أخرى">مصروف أخرى</option>';
  toggleExpFields();
}
function toggleExpFields(){
  var t=$('exType').value, c=$('exCategory').value;
  $('exStudentWrap').style.display=(t==='in'&&c==='فلوس درس')?'block':'none';
  $('exAssistWrap').style.display=(t==='out'&&c==='مرتب اسيستنت')?'block':'none';
}
$('btnAddTr').onclick=function(){
  var type=$('exType').value, cat=$('exCategory').value, amount=+toLatin($('exAmount').value), date=$('exDate').value||TODAY, note=$('exNote').value.trim();
  if(!amount||amount<=0){toast('مبلغ غير صحيح');return;}
  var t={id:'t'+Date.now(),date:date,month:date.slice(0,7),type:type,category:cat,amount:amount,note:note,by:db.currentUser||''};
  if(type==='in'&&cat==='فلوس درس'){
    var sid=$('exStudent').value; if(!sid){toast('اختار الطالب');return;}
    var s=getStudentById(sid), ci=cycleInfo(s);
    t.studentId=sid; t.studentName=s.name; t.period=ci.key; t.receiptNo=nextReceipt();
    if(cyclePayTx(s)){toast('الدورة الحالية مدفوعة للطالب ده');return;}
  }
  if(type==='out'&&cat==='مرتب اسيستنت'){ var an=$('exAssist').value.trim(); if(!an){toast('اكتب اسم الاسيستنت');return;} t.assistantName=an; }
  db.transactions.push(t); save();
  $('exAmount').value=''; $('exNote').value='';
  renderExpenses(); renderTreasury(); renderStudents(); renderPayment(); renderHome(); toast('تم تسجيل العملية');
};
function renderExpenses(){
  var m=$('exFilterMonth').value||CUR_MONTH;
  var list=db.transactions.filter(function(t){return t.date.slice(0,7)===m;}).slice().reverse();
  $('exBody').innerHTML=list.map(function(t){
    return '<tr><td class="muted">'+t.date+'</td><td>'+(t.type==='in'?'<span class="badge b-ok">داخل</span>':'<span class="badge b-bad">خارج</span>')+'</td><td>'+t.category+'</td><td class="muted">'+(t.studentName||t.assistantName||'—')+'</td><td class="muted">'+(t.period||'—')+'</td><td class="muted">'+esc(t.note||'')+'</td><td style="font-weight:700">'+money(t.amount)+'</td><td><button class="iconbtn del" onclick="delTr(\''+t.id+'\')">'+ic('trash','sm')+'</button></td></tr>';
  }).join('')||'<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">مفيش عمليات</td></tr>';
}
function delTr(id){ if(!confirm('حذف العملية؟'))return; db.transactions=db.transactions.filter(function(t){return t.id!==id;}); save(); renderExpenses(); renderTreasury(); renderStudents(); renderPayment(); renderHome(); }

/* ========== 16) الاسيستنت ========== */
$('btnAddAs').onclick=function(){
  var name=$('asName').value.trim(); if(!name){toast('اكتب الاسم');return;}
  var id=$('asEdit').value||('a'+Date.now());
  var data={id:id,name:name,phone:toLatin($('asPhone').value.trim()),salary:+toLatin($('asSalary').value)||0};
  var ex=db.assistants.find(function(a){return a.id===id;});
  if(ex) Object.assign(ex,data); else db.assistants.push(data);
  $('asEdit').value=''; $('asName').value=''; $('asPhone').value=''; $('asSalary').value=''; $('btnAsCancel').style.display='none';
  save(); renderAssistants(); renderHeader(); toast('تم الحفظ');
};
function editAs(id){ var a=db.assistants.find(function(x){return x.id===id;}); if(!a)return; $('asEdit').value=id; $('asName').value=a.name; $('asPhone').value=a.phone||''; $('asSalary').value=a.salary; $('btnAsCancel').style.display='inline-flex'; }
function delAs(id){ if(!confirm('حذف الاسيستنت؟'))return; db.assistants=db.assistants.filter(function(a){return a.id!==id;}); save(); renderAssistants(); renderHeader(); }
$('btnAsCancel').onclick=function(){ $('asEdit').value=''; $('asName').value=''; $('asPhone').value=''; $('asSalary').value=''; $('btnAsCancel').style.display='none'; };
function renderAssistants(){
  $('asBody').innerHTML=db.assistants.map(function(a){
    return '<tr><td style="font-weight:700">'+esc(a.name)+'</td><td class="muted">'+(a.phone||'—')+'</td><td>'+money(a.salary)+'</td><td style="white-space:nowrap"><button class="iconbtn" onclick="editAs(\''+a.id+'\')">'+ic('edit','sm')+'</button> <button class="iconbtn del" onclick="delAs(\''+a.id+'\')">'+ic('trash','sm')+'</button></td></tr>';
  }).join('')||'<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">مفيش اسيستنت</td></tr>';
  refreshSelects();
}
function refreshSelects(){
  $('exStudent').innerHTML='<option value="">— اختر طالب —</option>'+db.students.map(function(s){return '<option value="'+s.id+'">'+esc(s.code)+' — '+esc(s.name)+'</option>';}).join('');
  $('assistList').innerHTML=db.assistants.map(function(a){return '<option value="'+esc(a.name)+'">';}).join('');
}

/* ========== 17) المجموعات ========== */
function groupsToday(){
  var d=String(new Date().getDay()), out=[];
  db.groups.forEach(function(g){ (g.sessions||[]).forEach(function(s){ if(String(s.day)===d) out.push({name:g.name,time:s.time}); }); });
  return out;
}
function fillDaySelects(){
  var opts='<option value="">— اختر —</option>';
  for(var i=0;i<7;i++) opts+='<option value="'+i+'">'+DAYS[i]+'</option>';
  ['gDay1','gDay2','gDay3'].forEach(function(id){ $(id).innerHTML=opts; });
}
['gTime1','gTime2','gTime3'].forEach(function(id){
  $(id).addEventListener('input', function(){ this.value=toLatin(this.value); });
});
function readGroupSessions(){
  var d1=$('gDay1').value, t1=toLatin($('gTime1').value).trim();
  if(d1===''||t1===''){ toast('يوم وميعاد الحصة الأولى إجباري'); return null; }
  var out=[{day:d1,time:t1}];
  var rows=[['gDay2','gTime2',2],['gDay3','gTime3',3]];
  for(var i=0;i<rows.length;i++){
    var d=$(rows[i][0]).value, t=toLatin($(rows[i][1]).value).trim();
    if(d===''&&t==='') continue;
    if(d===''||t===''){ toast('كمّل يوم وميعاد الحصة '+rows[i][2]); return null; }
    out.push({day:d,time:t});
  }
  return out;
}
function resetGroupForm(){
  $('gEditId').value=''; $('gName').value='';
  ['1','2','3'].forEach(function(n){ $('gDay'+n).value=''; $('gTime'+n).value=''; });
  $('btnSaveGroup').innerHTML=ic('plus','sm')+' إضافة المجموعة';
  $('btnGroupCancelEdit').style.display='none';
}
$('btnSaveGroup').onclick=function(){
  var name=$('gName').value.trim();
  if(!name){toast('اكتب اسم المجموعة');return;}
  var sessions=readGroupSessions(); if(!sessions)return;
  var id=$('gEditId').value;
  if(db.groups.some(function(g){return g.name===name&&g.id!==id;})){toast('فيه مجموعة بنفس الاسم');return;}
  if(id){
    var g=db.groups.find(function(x){return x.id===id;});
    if(g){
      var oldName=g.name;
      g.name=name; g.sessions=sessions;
      if(oldName!==name) db.students.forEach(function(s){ if((s.group||'').trim()===oldName) s.group=name; });
    }
  }else{
    db.groups.push({id:'g'+Date.now(),name:name,sessions:sessions});
  }
  save(); resetGroupForm(); renderGroups(); refreshGroupSelects(); renderAttendance(); renderHome(); renderStudents(); toast('تم حفظ المجموعة');
};
$('btnGroupCancelEdit').onclick=resetGroupForm;
function editGroup(id){
  var g=db.groups.find(function(x){return x.id===id;}); if(!g)return;
  $('gEditId').value=g.id; $('gName').value=g.name;
  var s=g.sessions||[];
  setSessionRow(1,s[0]); setSessionRow(2,s[1]); setSessionRow(3,s[2]);
  $('btnSaveGroup').innerHTML=ic('save','sm')+' حفظ التعديل';
  $('btnGroupCancelEdit').style.display='inline-flex';
}
function setSessionRow(n,s){ $('gDay'+n).value=s?s.day:''; $('gTime'+n).value=s?s.time:''; }
function delGroup(id){
  if(!confirm('حذف المجموعة؟ (الطلاب هيفضلوا محتفظين باسمها)'))return;
  db.groups=db.groups.filter(function(g){return g.id!==id;});
  save(); renderGroups(); refreshGroupSelects(); renderAttendance(); renderHome(); toast('تم حذف المجموعة');
}
function renderGroups(){
  $('groupsList').innerHTML=db.groups.map(function(g){
    var chips=(g.sessions||[]).map(function(s){return '<span class="badge b-in">'+DAYS[+s.day]+' '+esc(s.time)+'</span>';}).join(' ');
    return '<div class="att-row"><div class="att-info"><b>'+esc(g.name)+'</b>'+chips+'</div><div style="display:flex;gap:6px"><button class="iconbtn" onclick="editGroup(\''+g.id+'\')">'+ic('edit','sm')+'</button><button class="iconbtn del" onclick="delGroup(\''+g.id+'\')">'+ic('trash','sm')+'</button></div></div>';
  }).join('')||'<p class="muted">مفيش مجموعات — ضيف أول مجموعة من فوق</p>';
}
function refreshGroupSelects(){
  var cur=$('atGroup').value;
  $('atGroup').innerHTML='<option value="">كل المجموعات</option>'+db.groups.map(function(g){return '<option value="'+esc(g.name)+'">'+esc(g.name)+' ('+toLatin((g.sessions||[]).length)+' حصة)</option>';}).join('');
  if(cur) $('atGroup').value=cur;
  $('rgGroup').innerHTML=groupOptions($('rgGroup').value||'');
}

/* ========== 18) الامتحانات ========== */
$('emDate').value=TODAY;
$('btnAddExam').onclick=function(){
  var t=$('emTitle').value.trim(); if(!t){toast('اكتب اسم الامتحان');return;}
  var em={id:'em'+Date.now(),title:t,date:$('emDate').value||TODAY,maxScore:+toLatin($('emMax').value)||100};
  db.exams.push(em); db.examGrades[em.id]={}; save(); $('emTitle').value='';
  renderExams(); $('emSelect').value=em.id; renderExamGrades(); refreshExamOptions(); toast('تم إنشاء الامتحان');
};
$('emSelect').onchange=function(){ renderExamGrades(); };
function renderExams(){
  var cur=$('emSelect').value;
  $('emSelect').innerHTML='<option value="">— اختر —</option>'+db.exams.map(function(e){return '<option value="'+e.id+'">'+esc(e.title)+' ('+e.date+')</option>';}).join('');
  if(cur&&db.exams.some(function(e){return e.id===cur;})) $('emSelect').value=cur;
  renderExamStats();
}
function renderExamGrades(){
  var eid=$('emSelect').value;
  if(!eid){ $('emBody').innerHTML='<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">اختر أو أنشئ امتحان</td></tr>'; return; }
  var em=db.exams.find(function(e){return e.id===eid;}), g=db.examGrades[eid]||{};
  $('emBody').innerHTML=db.students.map(function(s){
    var r=g[s.id]||{};
    return '<tr><td style="font-weight:700">'+s.code+'</td><td>'+esc(s.name)+'</td><td><input type="number" min="0" max="'+em.maxScore+'" data-sid="'+s.id+'" class="em-score" value="'+esc(r.score===undefined?'':r.score)+'"></td><td><input type="text" data-sid="'+s.id+'" class="em-note" value="'+esc(r.note||'')+'" placeholder="ملاحظة"></td></tr>';
  }).join('')||'<tr><td colspan="4" class="muted" style="text-align:center">مفيش طلاب</td></tr>';
}
$('btnSaveGrades').onclick=function(){
  var eid=$('emSelect').value; if(!eid){toast('اختر امتحان');return;}
  var em=db.exams.find(function(e){return e.id===eid;}), g={};
  document.querySelectorAll('.em-score').forEach(function(i){
    var sid=i.dataset.sid, v=parseFloat(toLatin(i.value));
    var n=document.querySelector('.em-note[data-sid="'+sid+'"]'); var note=n?n.value.trim():'';
    if(!isNaN(v)) g[sid]={score:Math.min(Math.max(v,0),em.maxScore),note:note};
    else if(note) g[sid]={score:'',note:note};
  });
  db.examGrades[eid]=g; save(); renderExamStats(); toast('تم حفظ الدرجات');
};
function renderExamStats(){
  var weak=db.settings.weak||50, top=db.settings.top||85;
  var rows=db.students.map(function(s){
    var sg=sessionGrades(s);
    var avg=sg.length?sg.reduce(function(a,g){return a+(parseFloat(g.score)||0);},0)/sg.length:null;
    var eg=examGrades(s); var last=eg.length?eg[eg.length-1]:null;
    var pct=(last&&last.max)?(last.score/last.max*100):null;
    return {s:s,avg:avg,last:last,pct:pct};
  });
  $('emStatsBody').innerHTML=rows.map(function(r){
    var rate='—';
    if(r.pct!==null) rate=r.pct>=top?'<span class="badge b-ok">ممتاز</span>':(r.pct<weak?'<span class="badge b-bad">ضعيف</span>':'<span class="badge b-mute">متوسط</span>');
    return '<tr><td style="font-weight:700">'+r.s.code+'</td><td>'+esc(r.s.name)+'</td><td>'+(r.avg!==null?toLatin(r.avg.toFixed(1))+' / 20':'—')+'</td><td>'+(r.last?toLatin(r.last.score)+'/'+toLatin(r.last.max):'—')+'</td><td>'+(r.pct!==null?toLatin(r.pct.toFixed(0))+'%':'—')+'</td><td>'+rate+'</td></tr>';
  }).join('')||'<tr><td colspan="6" class="muted" style="text-align:center">مفيش طلاب</td></tr>';
  renderQuizStats();
}
$('btnPrintStats').onclick=function(){
  printHTML('<h2>'+db.settings.centerName+' — إحصائيات الدرجات</h2><table><tr><th>الكود</th><th>الاسم</th><th>متوسط كويز (من 20)</th><th>آخر امتحان</th><th>النسبة</th></tr>'+db.students.map(function(s){
    var sg=sessionGrades(s); var avg=sg.length?(sg.reduce(function(a,g){return a+(parseFloat(g.score)||0);},0)/sg.length).toFixed(1):'—';
    var eg=examGrades(s); var l=eg.length?eg[eg.length-1]:null; var p=(l&&l.max)?(l.score/l.max*100).toFixed(0)+'%':'—';
    return '<tr><td>'+s.code+'</td><td>'+esc(s.name)+'</td><td>'+toLatin(avg)+'</td><td>'+(l?toLatin(l.score)+'/'+toLatin(l.max):'—')+'</td><td>'+toLatin(p)+'</td></tr>';
  }).join('')+'</table>');
};

/* ========== 19) تحليل الكويزات + الرسمة ========== */
function quizStats(){
  var perStudent=db.students.map(function(s){
    var sg=sessionGrades(s).filter(function(g){ return !isNaN(parseFloat(g.score)); });
    if(!sg.length) return null;
    var avg=sg.reduce(function(a,g){ return a+parseFloat(g.score); },0)/sg.length;
    return {name:s.name, code:s.code, avg:avg, count:sg.length};
  }).filter(Boolean);
  var buckets={};
  db.students.forEach(function(s){
    sessionGrades(s).forEach(function(g){
      var v=parseFloat(g.score); if(isNaN(v)) return;
      buckets[g.date]=buckets[g.date]||{sum:0,n:0};
      buckets[g.date].sum+=v; buckets[g.date].n++;
    });
  });
  var perSession=Object.keys(buckets).sort().map(function(d){ return {name:d, avg:buckets[d].sum/buckets[d].n, count:buckets[d].n}; });
  return {perStudent:perStudent, perSession:perSession};
}
function renderQuizStats(){
  var st=quizStats(), scores=[];
  db.students.forEach(function(s){ sessionGrades(s).forEach(function(g){ var v=parseFloat(g.score); if(!isNaN(v)) scores.push(v); }); });
  $('qzCount').textContent=toLatin(scores.length);
  if(scores.length){
    var sum=scores.reduce(function(a,b){return a+b;},0);
    $('qzAvg').textContent=toLatin((sum/scores.length).toFixed(1));
  }else $('qzAvg').textContent='—';
  if(st.perStudent.length){
    var sorted=st.perStudent.slice().sort(function(a,b){return b.avg-a.avg;});
    $('qzHigh').textContent=toLatin(sorted[0].avg.toFixed(1)); $('qzHigh').title=sorted[0].name;
    $('qzLow').textContent=toLatin(sorted[sorted.length-1].avg.toFixed(1)); $('qzLow').title=sorted[sorted.length-1].name;
  }else{ $('qzHigh').textContent='—'; $('qzLow').textContent='—'; }
  drawQuizChart();
}
function truncate(s,n){ s=String(s); return s.length>n? s.slice(0,n-1)+'…' : s; }
function roundTopRect(ctx,x,y,w,h,r){
  if(h<=0){ return; }
  if(h<r) r=h;
  ctx.beginPath();
  ctx.moveTo(x,y+h); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h);
  ctx.closePath();
}
function drawQuizChart(){
  var cv=$('quizChart'); if(!cv) return;
  var cssW=cv.clientWidth, cssH=cv.clientHeight||260;
  if(!cssW) return;
  var mode=$('chartMode')?$('chartMode').value:'student';
  var st=quizStats();
  var data=(mode==='student'?st.perStudent:st.perSession).slice();
  if(mode==='student') data.sort(function(a,b){return b.avg-a.avg;});
  data=data.slice(0,12);
  var dpr=window.devicePixelRatio||1;
  cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr);
  var ctx=cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);
  var padL=34,padR=8,padT=16,padB=52;
  var w=cssW-padL-padR, h=cssH-padT-padB;
  ctx.strokeStyle='#e5e9f2'; ctx.lineWidth=1;
  ctx.fillStyle='#6b7280'; ctx.font='11px Tajawal, sans-serif';
  for(var g=0;g<=4;g++){
    var val=QUIZ_MAX*g/4, y=padT+h-(h*g/4);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(padL+w,y); ctx.stroke();
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(String(val), padL-6, y);
  }
  if(!data.length){
    ctx.fillStyle='#6b7280'; ctx.font='13px Tajawal, sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('مفيش بيانات كويزات لسه — سجّل حضور بدرجات كويز الأول', cssW/2, cssH/2);
    return;
  }
  var n=data.length, slot=w/n, barW=Math.min(46, slot*0.55);
  for(var i=0;i<n;i++){
    var d=data[i];
    var bh=h*(Math.max(0,Math.min(QUIZ_MAX,d.avg))/QUIZ_MAX);
    var x=padL+slot*i+(slot-barW)/2, y=padT+h-bh;
    var grad=ctx.createLinearGradient(0,y,0,padT+h);
    grad.addColorStop(0,'#7c3aed'); grad.addColorStop(1,'#4f46e5');
    ctx.fillStyle=grad;
    roundTopRect(ctx,x,y,barW,bh,6); ctx.fill();
    ctx.fillStyle='#111827'; ctx.font='bold 11px Tajawal, sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(d.avg.toFixed(1), x+barW/2, y-3);
    ctx.save();
    ctx.translate(x+barW/2, padT+h+8);
    ctx.rotate(-0.55);
    ctx.fillStyle='#6b7280'; ctx.font='10px Tajawal, sans-serif';
    ctx.textAlign='right'; ctx.textBaseline='top';
    ctx.fillText(truncate(mode==='student'? d.name : d.name.slice(5), 12), 0, 0);
    ctx.restore();
  }
  ctx.strokeStyle='#cbd5e1'; ctx.beginPath();
  ctx.moveTo(padL,padT+h); ctx.lineTo(padL+w,padT+h); ctx.stroke();
}
if($('chartMode')) $('chartMode').addEventListener('change', drawQuizChart);
window.addEventListener('resize', debounce(drawQuizChart,150));

/* ========== 20) تصدير CSV ========== */
function csvCell(v){ v=(v==null?'':String(v)); return '"'+v.replace(/"/g,'""')+'"'; }
function csvDownload(name,header,rows){
  var lines=[header.join(',')];
  rows.forEach(function(r){ lines.push(r.map(csvCell).join(',')); });
  var blob=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
$('btnCsvStudents').onclick=function(){
  csvDownload('students-'+TODAY+'.csv',['الكود','الاسم','السنة','النوع','المجموعة','المدرسة','تاريخ البدء','رقم الطالب','رقم ولي الأمر','دفع مبدئي','المتبقي','غياب','الحالة'],
    db.students.map(function(s){return [s.code,s.name,s.year||'',s.type||'',s.group||'',s.school||'',s.startDate,s.phone||'',s.parentPhone||'',s.paidAmount||0,calcRemaining(s),calcAbsence(s),STATUS_LABEL[s.status||'active']];}));
  toast('تم تصدير الطلاب CSV');
};
$('btnCsvTreasury').onclick=function(){
  csvDownload('treasury-'+TODAY+'.csv',['التاريخ','النوع','الفئة','الاسم','المبلغ','ملاحظات','الدورة'],
    db.transactions.map(function(t){return [t.date,t.type==='in'?'داخل':'خارج',t.category,t.studentName||t.assistantName||'',t.amount,t.note||'',t.period||''];}));
  toast('تم تصدير الخزنة CSV');
};
$('btnCsvGrades').onclick=function(){
  var rows=[];
  db.students.forEach(function(s){
    sessionGrades(s).forEach(function(g){ rows.push([s.code,s.name,'كويز (من 20)',g.date,g.score,'']); });
    examGrades(s).forEach(function(g){ rows.push([s.code,s.name,'امتحان',g.title,g.score,g.max]); });
  });
  csvDownload('grades-'+TODAY+'.csv',['الكود','الاسم','النوع','البيان','الدرجة','من'],rows);
  toast('تم تصدير الدرجات CSV');
};

/* ========== 21) نسخ احتياطي محلي ========== */
$('btnExport').onclick=function(){
  var blob=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='markaz-backup-'+TODAY+'.json'; a.click(); toast('تم التصدير');
};
$('btnImportClick').onclick=function(){ $('btnImport').click(); };
$('btnImport').onchange=function(e){
  var f=e.target.files[0]; if(!f)return;
  var r=new FileReader();
  r.onload=function(){ try{ var d=JSON.parse(r.result); if(!d.students||!d.settings)throw 0; db=d; db.groups=db.groups||[]; db.counters=db.counters||{receipt:0}; migrateGroups(); db.students.forEach(function(s){ if(!s.startDate)s.startDate=(s.startMonth||CUR_MONTH)+'-01'; }); save(); renderAll(); toast('تم الاستيراد'); }catch(err){ toast('ملف غير صالح'); } };
  r.readAsText(f); e.target.value='';
};
$('btnWipe').onclick=function(){ if(!confirm('هتمسح كل البيانات. متأكد؟'))return; lsDel(LS); location.reload(); };

/* ========== 22) الهيدر + دخول + تشغيل ========== */
function renderHeader(){
  $('sideCenter').textContent=db.settings.centerName;
  var users=[db.settings.teacherName];
  db.assistants.forEach(function(a){ users.push(a.name); });
  if(users.indexOf(db.currentUser)<0) db.currentUser=users[0];
  $('userSelect').innerHTML=users.map(function(u){ return '<option '+(u===db.currentUser?'selected':'')+'>'+u+'</option>'; }).join('');
}
$('userSelect').onchange=function(e){ db.currentUser=e.target.value; save(); };
$('btnSettings').onclick=function(){
  $('setCenter').value=db.settings.centerName; $('setTeacher').value=db.settings.teacherName;
  $('setP1').value=db.settings.p1; $('setP2').value=db.settings.p2; $('setP3').value=db.settings.p3;
  $('setPrice').value=db.settings.monthlyPrice; $('setWa').value=db.settings.whatsappNumber;
  renderGroups();
  $('mSettings').classList.add('show');
};
$('btnSaveSettings').onclick=function(){
  db.settings.centerName=$('setCenter').value.trim()||'سنتر مستر اشرف عبدالحليم';
  db.settings.teacherName=$('setTeacher').value.trim()||'مستر اشرف عبدالحليم';
  db.settings.p1=+toLatin($('setP1').value)||0; db.settings.p2=+toLatin($('setP2').value)||0; db.settings.p3=+toLatin($('setP3').value)||0;
  db.settings.monthlyPrice=+toLatin($('setPrice').value)||0; db.settings.whatsappNumber=toLatin($('setWa').value.trim());
  save(); renderHeader(); renderStudents(); renderPayment(); toast('تم حفظ الإعدادات');
};
$('btnCloudPush').onclick=function(){ cloudPush(); };
$('btnCloudPull').onclick=function(){ cloudPull(true).then(function(c){ if(c) toast('تم السحب من السحاب'); }); };

function arAuthErr(c){
  if(c==='auth/invalid-credential'||c==='auth/wrong-password') return 'بيانات الدخول غلط.';
  if(c==='auth/user-not-found') return 'مفيش مستخدم بالإيميل ده — ضيفه من كونصول Firebase.';
  if(c==='auth/too-many-requests') return 'محاولات كتير — استنى شوية.';
  if(c==='auth/network-request-failed') return 'مفيش اتصال بالنت.';
  return 'فشل الدخول: '+c;
}
function showLogin(localOnly){
  $('appShell').style.display='none';
  $('loginScreen').style.display='flex';
  $('btnLocal').style.display=localOnly?'block':'none';
  $('lgNote').textContent=localOnly?'فايرباس مش متظبط لسه — حط إعداداتك في fb-config.js عشان الدخول السحابي.':'';
}
function enterApp(){
  $('loginScreen').style.display='none';
  $('appShell').style.display='';
  load(); renderAll();
  if(FB_READY&&CU&&CU.uid!=='local'){
    setCloudStatus('بيتم المزامنة...');
    cloudPull(false).then(function(){ startLiveSync(); });
  }
}
function bootAuth(){
  if(!initFirebase()){ showLogin(true); return; }
  fbAuth.onAuthStateChanged(function(u){
    if(u){ CU=u; enterApp(); }
    else { CU=null; showLogin(false); }
  });
}
$('btnLogin').onclick=function(){
  if(!FB_READY){ $('lgErr').textContent='اربط فايرباس الأول (ملف fb-config.js).'; return; }
  var em=$('lgEmail').value.trim(), pw=$('lgPass').value;
  $('lgErr').textContent='';
  fbAuth.signInWithEmailAndPassword(em,pw).catch(function(e){ $('lgErr').textContent=arAuthErr(e.code); });
};
$('btnLocal').onclick=function(){ CU={email:'local@local', uid:'local'}; enterApp(); };
$('btnLogout').onclick=function(){
  if(FB_READY&&CU&&CU.uid!=='local'){ cloudPush().then(function(){ fbAuth.signOut(); }); }
  else { CU=null; showLogin(!FB_READY); }
};

function renderAll(){
  autoUnfreeze();
  buildIndexes();
  renderHeader(); renderHome(); renderAttendance(); renderStudents(); renderPayment(); renderTreasury();
  renderExpForm(); renderExpenses(); renderAssistants(); renderGroups(); refreshGroupSelects();
  renderExams(); renderExamGrades(); refreshExamOptions();
}
window.addEventListener('error', function(e){
  var msg=e.message||'';
  if(msg==='Script error.'||msg==='Script error'||(e.lineno===0&&e.colno===0))return;
  var d=document.getElementById('errbar');
  if(d){ d.textContent='JS Error: '+msg+' (line '+e.lineno+')'; d.classList.add('show'); }
});

/* إتاحة الدوال للي بيتنادى عليها من onclick */
window.undoAttend=undoAttend; window.openEdit=openEdit; window.openProfile=openProfile;
window.setSesScore=setSesScore; window.setSesNotes=setSesNotes; window.delSession=delSession;
window.delStudent=delStudent; window.payNow=payNow; window.editPay=editPay; window.undoPay=undoPay;
window.printReceipt=printReceipt; window.printStatement=printStatement; window.delTr=delTr;
window.editAs=editAs; window.delAs=delAs; window.editGroup=editGroup; window.delGroup=delGroup;
window.payMore=payMore;

/* بدء التشغيل */
fillDaySelects();
bootAuth();
/* ========== 23) تحديد سعر الشهر تلقائيًا حسب السنة ========== */
function priceForYear(y){
  var s=db.settings;
  if(y==='1') return (+s.p1||0);
  if(y==='2') return (+s.p2||0);
  if(y==='3') return (+s.p3||0);
  return (+s.monthlyPrice||0);
}
function yearName(y){ return y==='1'?'أولى':(y==='2'?'تانية':(y==='3'?'تالتة':'')); }
function priceHintEl(selEl, id){
  var el=document.getElementById(id);
  if(!el){
    el=document.createElement('div');
    el.id=id; el.className='muted';
    el.style.marginTop='4px'; el.style.fontWeight='700'; el.style.color='var(--p)';
    selEl.parentNode.insertBefore(el, selEl.nextSibling);
  }
  return el;
}
function updateRgHint(){
  var y=$('rgYear').value, el=priceHintEl($('rgYear'),'rgPriceHint');
  el.textContent = y ? ('سعر الشهر لسنة '+yearName(y)+': '+money(priceForYear(y))) : '';
}
function updateEdHint(){
  var y=$('edYear').value, el=priceHintEl($('edYear'),'edPriceHint');
  el.textContent = y ? ('سعر الشهر لسنة '+yearName(y)+': '+money(priceForYear(y))) : '';
}

var rgRemainManual=false;
/* لو عدّل المتبقي بإيده، مبطلناش نلغبطه */
$('rgRemain').addEventListener('input', function(){ rgRemainManual=true; });

/* أول ما يختار السنة: المتبقي = سعر شهر السنة دي − اللي دفعه */
$('rgYear').addEventListener('change', function(){
  rgRemainManual=false;
  updateRgHint();
  var y=this.value; if(!y) return;
  var p=priceForYear(y);
  var paid=+toLatin($('rgPaid').value)||0;
  var rem=Math.max(0,p-paid);
  $('rgRemain').value=rem;
  toast('سعر شهر '+yearName(y)+' = '+money(p)+' — المتبقي اتحدد تلقائيًا');
});

/* لو كتب "دفع كم" بعد ما اختار السنة، المتبقي يتظبط لوحده برضه */
$('rgPaid').addEventListener('input', function(){
  var y=$('rgYear').value;
  if(!y||rgRemainManual) return;
  var p=priceForYear(y);
  var paid=+toLatin(this.value)||0;
  $('rgRemain').value=Math.max(0,p-paid);
});

/* بعد التسجيل: نرجّع كل حاجة فاضية */
$('btnReg').addEventListener('click', function(){
  setTimeout(function(){ rgRemainManual=false; updateRgHint(); },0);
});

/* في تعديل طالب: اعرض السعر الجديد بس من غير ما نلمس المتبقي الفعلي (ده دين حقيقي) */
$('edYear').addEventListener('change', function(){
  updateEdHint();
  var y=this.value;
  if(y) toast('سعر الشهر لسنة '+yearName(y)+': '+money(priceForYear(y))+' — المتبقي الفعلي متغيرش');
});
var _openEditOrig=window.openEdit;
window.openEdit=function(id){ _openEditOrig(id); updateEdHint(); };

updateRgHint();
/* ========== 24) حذف الامتحان الشامل ========== */
(function(){
  var sel = $('emSelect');
  if(!sel) return;

  /* زر الحذف بيتزرع لوحده جنب قائمة "اختر امتحان" — من غير تعديل HTML */
  var btn = document.getElementById('btnDelExam');
  if(!btn){
    btn = document.createElement('button');
    btn.id = 'btnDelExam';
    btn.type = 'button';
    btn.className = 'btn danger';
    btn.style.alignSelf = 'flex-end';
    btn.innerHTML = ic('trash','sm')+' حذف الامتحان';
    sel.parentNode.insertBefore(btn, sel.nextSibling);
  }

  function refreshState(){ btn.disabled = !sel.value; }

  btn.onclick = function(){
    var eid = sel.value;
    if(!eid){ toast('اختار الامتحان اللي عايز تحذفه الأول'); return; }
    var em = db.exams.find(function(e){ return e.id===eid; });
    if(!em) return;
    if(!confirm('هتحذف امتحان "'+em.title+'" وكل درجاته (بما فيها درجات اللي اتسجلت من شاشة الحضور). متأكد؟')) return;
    db.exams = db.exams.filter(function(e){ return e.id!==eid; });
    if(db.examGrades[eid]) delete db.examGrades[eid];
    save();
    renderExams();
    renderExamGrades();
    refreshExamOptions();
    refreshState();
    toast('تم حذف الامتحان: '+em.title);
  };

  /* خلي الزر مقفول طول ما مفيش امتحان مختار */
  sel.addEventListener('change', refreshState);
  var _renderExamsOrig = renderExams;
  renderExams = function(){ _renderExamsOrig(); refreshState(); };
  refreshState();
})();