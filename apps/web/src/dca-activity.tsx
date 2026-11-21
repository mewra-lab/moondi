import type { DcaActivity, DcaBuy } from '@moondi/shared'
import { ChevronRightIcon } from './icons'

export const DcaActivityPanel = ({ activity, dates, money, quantity, language, valuesVisible }: {
  activity: DcaActivity
  dates: Intl.DateTimeFormat
  money: Intl.NumberFormat
  quantity: Intl.NumberFormat
  language: 'th' | 'en'
  valuesVisible: boolean
}) => {
  const th = language === 'th'
  const { buys, signal, truncated } = activity
  const [recentBuys, olderBuys] = [buys.slice(0, 8), buys.slice(8)]
  const tradeRows = (rows: DcaBuy[]) => rows.map((buy) => (
    <li className="dca-buy" key={buy.id}>
      <details>
        <summary className="dca-buy-row">
          <span className="dca-buy-name">
            <strong>{buy.reason ?? (th ? 'ซื้อผ่านบอท' : 'Bot buy')}</strong>
            <time dateTime={new Date(buy.executedAt).toISOString()}>{dates.format(buy.executedAt)}</time>
          </span>
          <span className="dca-buy-total">
            {buy.thbAmount !== null ? <strong className={valuesVisible ? undefined : 'value-concealed'}>{money.format(buy.thbAmount)}</strong> : <span>—</span>}
            {buy.price === null ? <small className="dca-unconfirmed">{th ? 'รอข้อมูลจับคู่' : 'Fill unavailable'}</small> : null}
          </span>
          <ChevronRightIcon className="dca-disclosure-icon" width={14} height={14} />
        </summary>
        {buy.price !== null ? <dl className={`dca-buy-details${valuesVisible ? '' : ' value-concealed'}`}>
          <div><dt>{th ? 'ราคาต่อเหรียญ' : 'Unit price'}</dt><dd>{money.format(buy.price)}</dd></div>
          <div><dt>{th ? 'จำนวนที่ได้รับ' : 'Quantity received'}</dt><dd>{buy.amount === null ? '—' : quantity.format(buy.amount)}</dd></div>
          <div><dt>{th ? 'ค่าธรรมเนียม' : 'Fee'}</dt><dd>{buy.fee === null ? '—' : money.format(buy.fee)}</dd></div>
        </dl> : <p className="dca-buy-details dca-fill-note">{th ? 'บอทยังไม่มีข้อมูลราคาหรือจำนวนที่จับคู่' : 'The bot has no reported fill price or quantity.'}</p>}
      </details>
    </li>
  ))

  return (
    <section aria-labelledby="dca-activity-title" className="asset-detail-section dca-activity">
      <div className="dca-heading">
        <h2 id="dca-activity-title">{th ? 'รายการซื้อ DCA' : 'DCA buys'}</h2>
        <span>{buys.length}{truncated ? '+' : ''} {th ? 'รายการ' : 'buys'}</span>
      </div>
      {signal ? <div className="dca-heartbeat">
        <strong className={signal.active ? 'dca-signal is-active' : 'dca-signal'}>{signal.active === null ? (th ? 'ไม่ทราบสถานะ' : 'State unavailable') : signal.active ? (th ? 'Signal เปิดอยู่' : 'Signal active') : (th ? 'Signal ปิดอยู่' : 'Signal inactive')}</strong>
        <time title={th ? 'บอทรายงานล่าสุด' : 'Bot last reported'} dateTime={new Date(signal.lastSeenAt).toISOString()}>{dates.format(signal.lastSeenAt)}</time>
        {signal.levels.length > 0 ? <span className="dca-levels">Fibo {signal.levels.join(' · ')}</span> : null}
        {signal.hasError ? <span className="history-error">{th ? 'บอทรายงานข้อผิดพลาดในรอบล่าสุด' : 'The bot reported an error in its latest cycle.'}</span> : null}
      </div> : null}
      {buys.length > 0 ? <>
        <ul className="dca-buy-list">{tradeRows(recentBuys)}</ul>
        {olderBuys.length > 0 ? <details className="dca-more-buys">
          <summary>{th ? `ดูอีก ${olderBuys.length} รายการ` : `Show ${olderBuys.length} more buys`}</summary>
          <ul className="dca-buy-list">{tradeRows(olderBuys)}</ul>
        </details> : null}
        {truncated ? <p className="asset-empty">{th ? 'แสดงเฉพาะ 200 รายการล่าสุดในช่วงที่เลือก' : 'Showing the latest 200 buys in the selected range.'}</p> : null}
      </> : <p className="asset-empty">{th ? 'ไม่มีรายการซื้อจากบอทในช่วงที่เลือก' : 'No bot buys in the selected range.'}</p>}
    </section>
  )
}
