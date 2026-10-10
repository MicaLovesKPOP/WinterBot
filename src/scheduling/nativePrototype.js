'use strict';

const path = require('node:path');
const { MessageFlags } = require('discord.js');
const { isVerifiedMember, isOrganizerMember } = require('./channelPolicy');
const {
  PreviewStore, assert, makeRound, memberOf, normalizedDay,
  addWindow, removeWindow, allDay, applyDays, applyTemplate,
  confirmSubmission, templateFromSubmission, reviewSnapshot, weekday,
} = require('./nativePrototypeState');
const UI = require('./nativePrototypeUi');

function createNativePrototype({policy, testMode, dataFile, logger=console.error}) {
  // Deliberate isolation: this preview cannot reach the production scheduling store.
  assert(testMode === true, 'The native UX prototype is available in scheduling TEST mode only.');
  const store = new PreviewStore(dataFile || path.join(process.cwd(),'scheduling-native-preview.json'));
  const eventPreview = require('./nativeEventPreview').createEventPreview({store,policy,logger});

  const isOwned = interaction => {
    if (!interaction.guildId || interaction.guildId !== policy.guildId ||
        interaction.channelId !== policy.logChannelId) return false;
    return isVerifiedMember(interaction.member,policy) ||
      isOrganizerMember(interaction.member,policy,interaction.guild?.ownerId);
  };

  async function startPreview(interaction, weeksAhead=0) {
    assert(isOrganizerMember(interaction.member,policy,interaction.guild?.ownerId),
      'Only organizers can post the test invitation.');
    assert(interaction.channelId===policy.logChannelId, 'Test invitations stay in #bot-logs.');
    let round;
    await store.transaction(state=>{
      round=makeRound(weeksAhead);
      state.rounds[round.id]=round;
    });
    // This is a real Discord message, but entirely inside #bot-logs.
    await interaction.reply(UI.invite(round));
    return round;
  }
  function getSnapshot(state, sessionId, userId) {
    const round=state.rounds[sessionId];
    assert(round, 'This test invitation is no longer available. Ask an organizer to open a new one.');
    const member=memberOf(round,userId);
    return {round,member,template:state.templates[userId]||null};
  }
  async function change(sessionId,userId,update) {
    let result;
    await store.transaction(state=>{
      const {round,member,template}=getSnapshot(state,sessionId,userId);
      const notice=update(round,member,state,template);
      result={round:structuredClone(round),member:structuredClone(member),
        template:structuredClone(state.templates[userId]||null),notice};
    });
    return result;
  }
  function snapshot(sessionId,userId) {
    const state=store.read();
    const {round,member,template}=getSnapshot(state,sessionId,userId);
    return {round,member,template};
  }
  async function respond(interaction, content) {
    if (interaction.isModalSubmit?.() && !interaction.isFromMessage?.()) {
      return interaction.reply(content);
    }
    const {flags, ...update}=content;
    return interaction.update(update);
  }
  async function errorResponse(interaction,error) {
    const message='WinterBot TEST: '+String(error.message||error).slice(0,300);
    if(interaction.replied||interaction.deferred) {
      return interaction.followUp({content:message,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
    }
    return interaction.reply({content:message,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
  }
  async function handle(interaction) {
    if (!String(interaction.customId||'').startsWith('wbux:')) return false;
    try {
      assert(isOwned(interaction),'This TEST interaction is only available to eligible members in #bot-logs.');
      const [prefix, action, sid, a, b, c] = interaction.customId.split(':');
      assert(prefix==='wbux' && /^[0-9a-f]{12}$/.test(sid), 'Invalid test session.');
      const uid=String(interaction.user.id);
      assert(/^\d{15,22}$/.test(uid), 'Discord user ID missing.');
      if(action==='open') {
        const s=await change(sid,uid,()=>{});
        await interaction.reply(UI.overview(s.round,s.member,s.template));
        return true;
      }
      if(action==='home') {
        const s=snapshot(sid,uid);
        await respond(interaction,UI.overview(s.round,s.member,s.template));
        return true;
      }
      if(action==='jump' || action==='day') {
        const date=action==='jump'?interaction.values?.[0]:a;
        const s=snapshot(sid,uid);
        assert(s.round.dates.includes(date),'Choose one of the candidate dates.');
        await respond(interaction,UI.dayView(s.round,s.member,date));
        return true;
      }
      if(action==='review') {
        const s=await change(sid,uid,(r,m)=>{m.reviewedSnapshot=reviewSnapshot(r,m);});
        await respond(interaction,UI.reviewView(s.round,s.member));
        return true;
      }
      if(action==='clock') {
        const s=await change(sid,uid,(_,m)=>{m.clockFormat=m.clockFormat==='12'?'24':'12';});
        await respond(interaction,UI.overview(s.round,s.member,s.template));
        return true;
      }
      if(action==='undo') {
        const s=await change(sid,uid,(_,m)=>{
          assert(m.undo,'No previous edit to undo.');
          m.draft=m.undo; m.undo=null; m.reviewedSnapshot=null;
          return 'Last draft edit undone.';
        });
        await respond(interaction,UI.overview(s.round,s.member,s.template,s.notice));
        return true;
      }
      if(action==='all' || action==='off') {
        const s=await change(sid,uid,(r,m)=>{
          assert(r.dates.includes(a),'Date not found.');
          applyDays(m,r,[a],action==='all'?allDay():{status:'unavailable',windows:[]});
          return 'Saved as a draft. Review before submitting.';
        });
        await respond(interaction,UI.dayView(s.round,s.member,a,s.notice));
        return true;
      }
      if(action==='add' || action==='editwin' || action==='bulkwin') {
        const s=snapshot(sid,uid);
        if(action==='bulkwin') {
          assert(s.member.selection.length>0,'Select dates before choosing hours.');
          await interaction.showModal(UI.windowModal(sid,null,a,s.member.clockFormat||'24',null,-1,true));
        } else if(action==='add') {
          assert(s.round.dates.includes(a),'Invalid date.');
          await interaction.showModal(UI.windowModal(sid,a,b,s.member.clockFormat||'24'));
        } else {
          assert(s.round.dates.includes(a),'Invalid date.');
          const index=Number(interaction.values?.[0]);
          const win=s.member.draft[a]?.windows?.[index];
          assert(win,'That time window no longer exists.');
          await interaction.showModal(UI.windowModal(sid,a,win.kind,s.member.clockFormat||'24',win,index));
        }
        return true;
      }
      if(action==='win') {
        const isBulk=a==='multi', date=isBulk?null:a, kind=b, index=Number(c);
        const field=name=>{
          const values=interaction.fields.getStringSelectValues(name);
          assert(Array.isArray(values) && values.length===1,'Select a value for '+name+'.');
          return values[0];
        };
        const start=String(field('start_h')).padStart(2,'0')+':'+field('start_m');
        const endHour=Number(field('end_h'));
        const end=endHour===24 ? (field('end_m')==='00'?'24:00':'invalid') :
          String(endHour).padStart(2,'0')+':'+field('end_m');
        const cap=field('cap'), win={start,end,kind,maxMinutes:cap==='none'?null:Number(cap)};
        // Validate the window even before the user confirms a bulk overwrite.
        normalizedDay({status:'available',windows:[win]});
        const s=await change(sid,uid,(r,m)=>{
          if(isBulk) {
            const dates=m.selection.filter(d=>r.dates.includes(d));
            assert(dates.length,'No selected dates.');
            m.pending={type:'bulk',dates,day:normalizedDay({status:'available',windows:[win]})};
            return 'Review the dates before applying.';
          }
          assert(r.dates.includes(date),'Invalid date.');
          m.undo=structuredClone(m.draft);
          m.reviewedSnapshot=null;
          const next=addWindow(m.draft[date],win,index);
          m.draft[date]=next;
          return 'Window added to your draft.';
        });
        await respond(interaction,isBulk?
          UI.pendingView(s.round,s.member,s.template):
          UI.dayView(s.round,s.member,date,s.notice));
        return true;
      }
      if(action==='delwin') {
        const index=Number(interaction.values?.[0]);
        const s=await change(sid,uid,(r,m)=>{
          assert(r.dates.includes(a),'Invalid date.');
          m.undo=structuredClone(m.draft);
          m.reviewedSnapshot=null;
          const next=removeWindow(m.draft[a],index);
          if(next) m.draft[a]=next; else delete m.draft[a];
          return 'Time window removed from your draft.';
        });
        await respond(interaction,UI.dayView(s.round,s.member,a,s.notice));
        return true;
      }
      if(action==='bulk' || action==='copy') {
        const s=await change(sid,uid,(r,m)=>{
          if(action==='copy') assert(r.dates.includes(a) && m.draft[a],
            'Choose an answered source day to copy.');
          m.selection=[];
          m.pending=null;
        });
        await respond(interaction,UI.multiView(s.round,s.member,action==='copy'?a:null));
        return true;
      }
      if(action==='dates' || action==='dest') {
        const selection=interaction.values||[];
        const source=action==='dest' && a!=='all'?a:null;
        const s=await change(sid,uid,(r,m)=>{
          assert(selection.length>0 && selection.every(d=>r.dates.includes(d)&&d!==source),
            'Choose valid dates.');
          m.selection=[...new Set(selection)];
        });
        await respond(interaction,UI.multiView(s.round,s.member,source));
        return true;
      }
      if(action==='bulkset' || action==='proposecopy' || action==='reuse' || action==='template') {
        const s=await change(sid,uid,(r,m,state,t)=>{
          if(action==='bulkset') {
            assert(m.selection.length,'Select dates first.');
            const day=a==='all'?allDay():a==='maybe'?allDay('tentative'):{status:'unavailable',windows:[]};
            m.pending={type:'bulk',dates:[...m.selection],day};
          } else if(action==='proposecopy') {
            assert(r.dates.includes(a)&&m.draft[a]&&m.selection.length,'Select destination dates first.');
            m.pending={type:'copy',source:a,dates:[...m.selection]};
          } else if(action==='reuse') {
            assert(t,'Save a usual week first.');
            m.pending={type:'reuse',dates:r.dates.filter(d=>t[weekday(d)])};
            assert(m.pending.dates.length,'Your template contains none of the requested weekdays.');
          } else {
            assert(m.submitted,'Submit availability before saving it as a template.');
            m.pending={type:'template',dates:r.dates};
          }
        });
        await respond(interaction,UI.pendingView(s.round,s.member,s.template));
        return true;
      }
      if(action==='cancel') {
        const s=await change(sid,uid,(_,m)=>{m.pending=null;});
        await respond(interaction,UI.overview(s.round,s.member,s.template,'Changes cancelled.'));
        return true;
      }
      if(action==='apply') {
        const s=await change(sid,uid,(r,m,state,t)=>{
          const p=m.pending;
          assert(p,'No changes awaiting confirmation.');
          if(p.type==='bulk') {
            applyDays(m,r,p.dates,p.day);
            return 'Availability applied to '+p.dates.length+' dates. Nothing submitted yet.';
          }
          if(p.type==='copy') {
            assert(m.draft[p.source], 'The source date is unanswered.');
            applyDays(m,r,p.dates,m.draft[p.source]);
            return 'Copied availability to '+p.dates.length+' dates. Nothing submitted yet.';
          }
          if(p.type==='reuse') {
            const dates=applyTemplate(m,r,t);
            return 'Usual week copied to '+dates.length+' dates. Review before submitting.';
          }
          if(p.type==='template') {
            state.templates[uid]=templateFromSubmission(r,m);
            m.pending=null;
            return 'Your usual week was saved for future test rounds.';
          }
          throw new Error('Unsupported confirmation.');
        });
        await respond(interaction,UI.overview(s.round,s.member,s.template,s.notice));
        return true;
      }
      if(action==='submit') {
        const s=await change(sid,uid,(r,m)=>{
          confirmSubmission(m,r);
          return 'Submitted! Your reviewed answers are recorded in this TEST round.';
        });
        await respond(interaction,UI.overview(s.round,s.member,s.template,s.notice));
        return true;
      }
      throw new Error('Unknown test action.');
    } catch(error) {
      try { await errorResponse(interaction,error); }
      catch(replyError) { logger('Native UX test reply failed:',replyError); }
      return true;
    }
  }
  return {startPreview,handle,store,eventPreview};
}
module.exports={createNativePrototype};