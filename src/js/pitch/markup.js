/** Static UI only. Source names and analysis values are inserted as text by panel.js. */
export const pitchPanelMarkup = `
<section id="pitch-section" class="pitch-panel" aria-labelledby="pitch-title">
  <div class="pitch-heading">
    <div><span class="pitch-eyebrow">PITCH ASSISTANT</span><h1 id="pitch-title">音高助手</h1></div>
    <span class="pitch-badge">本機分析 · 不上傳音訊</span>
  </div>
  <p class="pitch-intro">不用絕對音感也能比較高低。先選一小段，看看可辨識的音高，再輪流聽原音和參考音。</p>
  <p id="pitch-source" class="pitch-source">尚未載入音訊</p>
  <div class="pitch-card">
    <h2>1. 選擇要聽的片段</h2>
    <p id="pitch-range-help" class="pitch-help">每次最多分析 60 秒；長音檔預設只選前 60 秒。更適合清楚的單人演唱或單音樂器。</p>
    <svg id="pitch-waveform" class="pitch-waveform" viewBox="0 0 800 100" preserveAspectRatio="none" role="img" aria-labelledby="pitch-waveform-title pitch-waveform-desc">
      <title id="pitch-waveform-title">原音波形總覽</title><desc id="pitch-waveform-desc">載入音訊後顯示取樣波形及已選範圍；也可用下方秒數欄位選取。</desc>
    </svg>
    <p class="pitch-help">波形為所選聲道的取樣總覽，顯示音量，不代表音高。可點選波形移動範圍，或直接輸入起訖秒數。</p>
    <div class="pitch-controls">
      <label>起點（秒）<input id="pitch-start" type="number" min="0" step="0.001" value="0" inputmode="decimal" aria-describedby="pitch-range-help pitch-range-error" disabled></label>
      <label>終點（秒）<input id="pitch-end" type="number" min="0" step="0.001" value="0" inputmode="decimal" aria-describedby="pitch-range-help pitch-range-error" disabled></label>
      <label>分析聲道<select id="pitch-channel" disabled></select></label>
      <button type="button" id="pitch-analyze" class="pitch-primary" disabled>分析所選片段</button>
      <button type="button" id="pitch-cancel" hidden>取消分析</button>
    </div>
    <p id="pitch-range-error" class="pitch-error" role="status"></p>
    <progress id="pitch-progress" max="1" value="0" aria-label="音高分析進度" hidden></progress>
    <p id="pitch-status" class="pitch-status" role="status" aria-live="polite">先在母帶模式載入原音檔，再回來選取片段</p>
  </div>
  <div class="pitch-workspace">
    <div class="pitch-card pitch-results">
      <h2>2. 看音高，再聽聽看</h2>
      <p id="pitch-summary" class="pitch-help">分析後才會顯示曲線；空白處表示沒有可靠音高，並非唱錯。</p>
      <svg id="pitch-contour" class="pitch-contour" viewBox="0 0 800 300" role="img" aria-labelledby="pitch-contour-title pitch-contour-desc">
        <title id="pitch-contour-title">所選片段的音高估計</title><desc id="pitch-contour-desc">尚未分析，沒有音高曲線。分析後可使用下方時間點控制及資料表查看相同資料。</desc>
      </svg>
      <p class="pitch-legend">實線／圓點：有可辨識音高　灰底空段：不確定或無明確音高　虛線：你選的參考音</p>
      <label class="pitch-point-label" for="pitch-point">查看時間點<input id="pitch-point" type="range" min="0" max="0" value="0" step="1" disabled></label>
      <p id="pitch-point-readout" class="pitch-readout" aria-live="polite">分析後可用方向鍵逐點查看；這裡會用文字說明高低</p>
      <details id="pitch-data"><summary>查看逐點資料</summary>
        <div class="pitch-table-wrap"><table><caption>音高估計原始時間點；不確定的點不當作音符</caption><thead><tr><th scope="col">原音時間</th><th scope="col">估計音名</th><th scope="col">頻率</th><th scope="col">判讀</th><th scope="col">查看</th></tr></thead><tbody id="pitch-rows"></tbody></table></div>
        <div class="pitch-controls"><button type="button" id="pitch-prev-page" disabled>上一頁</button><span id="pitch-page">尚無資料</span><button type="button" id="pitch-next-page" disabled>下一頁</button></div>
      </details>
    </div>
    <aside class="pitch-card pitch-reference" aria-labelledby="pitch-reference-title">
      <h2 id="pitch-reference-title">3. 選一個參考音</h2>
      <p class="pitch-help">參考音由你選；不是歌曲的標準答案。音名旁的數字表示八度，數字越大音越高。</p>
      <label for="pitch-target">參考音名<select id="pitch-target"></select></label>
      <p id="pitch-target-description" class="pitch-help"></p>
      <div class="pitch-ab"><button type="button" id="pitch-play-original" disabled>A · 聽所選原音</button><button type="button" id="pitch-play-tone">B · 聽參考音（2 秒）</button><button type="button" id="pitch-stop">停止試聽</button></div>
      <label for="pitch-tone-volume">參考音音量<input id="pitch-tone-volume" type="range" min="0" max="0.06" step="0.005" value="0.03"></label>
      <p class="pitch-help">參考音使用較小音量的純音；A 播放原音所有聲道，不套用母帶效果。戴耳機時，請先把裝置音量調低。A、B 輪流播放。</p>
      <p id="pitch-preview-status" class="pitch-help" role="status">尚未試聽</p>
      <details><summary>怎麼理解「音分」？</summary><p class="pitch-help">100 音分 = 一個半音。顯示「比參考音高 30 音分」，表示這個時間點略高於你選的音。超過 100 音分時，可能本來就在唱別的音，不能直接判定走音。</p></details>
    </aside>
  </div>
  <details class="pitch-card pitch-limits" open><summary>這個工具能告訴你什麼？</summary>
    <p>這是單音音高估計，不會分離人聲，也不能判斷旋律是否唱對。整首混音、和聲、伴奏、氣聲、子音、殘響與低音都可能造成誤判；必要時改用更乾淨的獨唱片段。</p>
    <p>有時會估成高一個或低一個八度。曲線和音名是聆聽輔助，不是正確率、演唱評分或修音結果。原音與匯出內容不會因這份分析而改變。</p>
  </details>
</section>`
