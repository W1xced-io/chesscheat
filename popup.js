const FILES='abcdefgh';
const squareCode=(sq)=>`${FILES.indexOf(sq[0])+1}${sq[1]}`;
const pieceChar=(p)=>({K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'}[p]||'');
let flipped=false, state={grid:{},best:'',score:null,depth:0,status:'idle'};

function render(){
  const el=document.getElementById('board');
  const files=flipped?[8,7,6,5,4,3,2,1]:[1,2,3,4,5,6,7,8];
  const ranks=flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
  let html='';
  for(const r of ranks) for(const f of files){
    const sq=`${f}${r}`; const p=state.grid[sq]||''; const dark=(f+r)%2===0;
    let bg=dark?'#4b5a6b':'#d7dee6';
    if(state.best&&state.best.length>=4){
      const from=squareCode(state.best.slice(0,2)), to=squareCode(state.best.slice(2,4));
      if(sq===from) bg='rgba(235,87,87,.55)';
      if(sq===to) bg='rgba(72,193,249,.5)';
    }
    html+=`<div style="display:flex;align-items:center;justify-content:center;background:${bg};color:${p?(p===p.toUpperCase()?'#fff':'#111'):'transparent'};font-size:22px;line-height:1">${pieceChar(p)}</div>`;
  }
  el.innerHTML=html;
  document.getElementById('best').textContent=state.best||'--';
  document.getElementById('eval').textContent=state.score?((state.score.type==='mate'?'M'+state.score.value:((state.score.value>=0?'+':'')+(state.score.value/100).toFixed(2)))):'--';
  document.getElementById('depth').textContent=state.depth?('d'+state.depth):'--';
  document.getElementById('status').textContent=state.status||'idle';
}

function load(){
  try{ const raw=localStorage.getItem('cc-ov-state'); if(raw) state=Object.assign(state, JSON.parse(raw)); }catch(e){}
  render();
}
document.getElementById('flip').addEventListener('click',()=>{ flipped=!flipped; render(); });
document.getElementById('open').addEventListener('click',()=>{ chrome.tabs.query({url:['https://www.chess.com/*','https://chess.com/*']},(tabs)=>{ if(tabs&&tabs[0]) chrome.tabs.update(tabs[0].id,{active:true}); else chrome.tabs.create({url:'https://www.chess.com/'}); }); });
load();
setInterval(load, 500);
