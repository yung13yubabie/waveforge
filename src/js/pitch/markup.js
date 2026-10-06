/** Static UI only. Source names and analysis values are inserted as text by panel.js. */
export const pitchPanelMarkup = `
<section id="pitch-section" class="pitch-panel" aria-labelledby="pitch-title">
  <header class="pitch-heading">
    <h1 id="pitch-title">音高助手</h1>
    <span class="pitch-badge">本機分析</span>
  </header>
  <div class="pitch-source-bar"><p id="pitch-source" class="pitch-source">尚未載入音訊</p><span class="pitch-scope">適用獨唱／單音樂器 · 空白不等於唱錯</span></div>
  <div class="pitch-card pitch-selection">
    <svg id="pitch-waveform" class="pitch-waveform" viewBox="0 0 800 100" preserveAspectRatio="none" role="img" aria-labelledby="pitch-waveform-title pitch-waveform-desc">
      <title id="pitch-waveform-title">原音波形總覽</title><desc id="pitch-waveform-desc">載入後顯示所選聲道的取樣波形。點選波形或用下方秒數調整範圍。</desc>
    </svg>
    <div class="pitch-controls pitch-range-toolbar">
      <label>起點（秒）<input id="pitch-start" type="number" min="0" step="0.001" value="0" inputmode="decimal" aria-describedby="pitch-range-help pitch-range-error" disabled></label>
      <label>終點（秒）<input id="pitch-end" type="number" min="0" step="0.001" value="0" inputmode="decimal" aria-describedby="pitch-range-help pitch-range-error" disabled></label>
      <label>聲道<select id="pitch-channel" disabled></select></label>
      <button type="button" id="pitch-analyze" class="pitch-primary" disabled>分析片段</button>
      <button type="button" id="pitch-cancel" hidden>取消</button>
      <span id="pitch-range-help" class="pitch-toolbar-hint">最多 60 秒 · 分析參考，不會修正音訊</span>
    </div>
    <p id="pitch-range-error" class="pitch-error" role="status"></p>
    <progress id="pitch-progress" max="1" value="0" aria-label="音高分析進度" hidden></progress>
    <p id="pitch-status" class="pitch-status" role="status" aria-live="polite">先載入原音檔</p>
  </div>
  <div class="pitch-workspace">
    <div class="pitch-card pitch-results">
      <div class="pitch-chart-heading"><h2>音高曲線</h2><span class="pitch-chart-key">實線：估計音高 · 虛線：參考音</span></div>
      <p id="pitch-summary" class="pitch-help">選好片段，再按「分析片段」</p>
      <svg id="pitch-contour" class="pitch-contour" viewBox="0 0 800 300" role="img" aria-labelledby="pitch-contour-title pitch-contour-desc">
        <title id="pitch-contour-title">所選片段的音高估計</title><desc id="pitch-contour-desc">尚未分析，沒有音高曲線。分析後可用時間點控制及資料表查看相同資料。</desc>
      </svg>
      <label class="pitch-point-label" for="pitch-point">查看位置<input id="pitch-point" type="range" min="0" max="0" value="0" step="1" disabled></label>
      <details id="pitch-data"><summary>逐點資料</summary>
        <div class="pitch-table-wrap"><table><caption>原音時間與音高估計；不確定的點不當作音符</caption><thead><tr><th scope="col">時間</th><th scope="col">音名</th><th scope="col">頻率</th><th scope="col">判讀</th><th scope="col">查看</th></tr></thead><tbody id="pitch-rows"></tbody></table></div>
        <div class="pitch-controls"><button type="button" id="pitch-prev-page" disabled>上一頁</button><span id="pitch-page">尚無資料</span><button type="button" id="pitch-next-page" disabled>下一頁</button></div>
      </details>
    </div>
    <aside class="pitch-card pitch-reference" aria-labelledby="pitch-reference-title">
      <h2 id="pitch-reference-title">目前音高</h2>
      <p id="pitch-point-readout" class="pitch-readout" aria-live="polite">分析後選一個時間點</p>
      <label for="pitch-target">比較參考音<select id="pitch-target"></select></label>
      <p id="pitch-target-description" class="pitch-help"></p>
      <div class="pitch-ab"><button type="button" id="pitch-play-original" disabled>A · 原音</button><button type="button" id="pitch-play-tone">B · 參考音</button><button type="button" id="pitch-stop">停止</button></div>
      <label for="pitch-tone-volume">參考音量<input id="pitch-tone-volume" type="range" min="0" max="0.06" step="0.005" value="0.03"></label>
      <p id="pitch-preview-status" class="pitch-help" role="status">先調低裝置音量，再輪流試聽</p>
    </aside>
  </div>
  <details class="pitch-card pitch-limits"><summary>如何判讀與使用</summary>
    <p>不用絕對音感也能比較高低。先選一小段並分析，再用曲線下方的滑桿選一個時間點；方向鍵可以逐點移動。點波形可移動範圍，起訖秒數可精確調整。長音檔預設只選前 60 秒。</p>
    <p>波形顯示音量，不代表音高。曲線實線／圓點是可辨識音高，灰底空段是不確定或無明確音高，虛線是你選的參考音。逐點資料提供相同資訊。</p>
    <p>100 音分等於一個半音；「比參考音高 30 音分」表示略高於你選的音。音名旁的數字表示八度，數字越大音越高。參考音由你選，不是歌曲的標準答案；相差較多可能本來就在唱別的音。</p>
    <p>A 播放原音所有聲道，不套用母帶效果；B 使用較小音量的純音，播放 2 秒。戴耳機時先把裝置音量調低。分析只使用所選聲道，不會把左右聲道相加。</p>
    <p>這是單音音高估計，不會分離人聲，也不能判斷旋律是否唱對。混音、和聲、伴奏、氣聲、子音、殘響與低音可能造成誤判，或估成高／低一個八度。更適合清楚的獨唱或單音樂器。</p>
    <p>分析在本機執行，不上傳音訊。曲線和音名不是正確率、演唱評分或修音結果，也不會改變原音與匯出內容。參考調音採十二平均律，A4 = 440 Hz。</p>
  </details>
</section>`
