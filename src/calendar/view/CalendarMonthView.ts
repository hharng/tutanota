import m, { Children, ClassComponent, Component, Vnode, VnodeDOM } from "mithril"
import { px, size } from "../../gui/size"
import { EventTextTimeOption, WeekStart } from "../../api/common/TutanotaConstants"
import type { CalendarDay, CalendarMonth } from "../date/CalendarUtils"
import {
	CALENDAR_EVENT_HEIGHT,
	EventLayoutMode,
	getAllDayDateForTimezone,
	getCalendarMonth,
	getDiffIn24hIntervals,
	getEventColor,
	getEventEnd,
	getFirstDayOfMonth,
	getStartOfDayWithZone,
	getStartOfNextDayWithZone,
	getStartOfTheWeekOffset,
	getTimeZone,
	getWeekNumber,
	layOutEvents,
	TEMPORARY_EVENT_OPACITY,
} from "../date/CalendarUtils"
import { incrementDate, incrementMonth, isToday, lastThrow, neverNull, ofClass } from "@tutao/tutanota-utils"
import { ContinuingCalendarEventBubble } from "./ContinuingCalendarEventBubble"
import { styles } from "../../gui/styles"
import { isAllDayEvent, isAllDayEventByTimes } from "../../api/common/utils/CommonCalendarUtils"
import { windowFacade } from "../../misc/WindowFacade"
import type { CalendarEvent } from "../../api/entities/tutanota/TypeRefs.js"
import type { GroupColors } from "./CalendarView"
import type { EventDragHandlerCallbacks, MousePos } from "./EventDragHandler"
import { EventDragHandler } from "./EventDragHandler"
import { getPosAndBoundsFromMouseEvent } from "../../gui/base/GuiUtils"
import { UserError } from "../../api/main/UserError"
import { showUserError } from "../../misc/ErrorHandlerImpl"
import { CalendarViewType, getDateFromMousePos, SELECTED_DATE_INDICATOR_THICKNESS } from "./CalendarGuiUtils"
import type { CalendarEventBubbleClickHandler, EventsOnDays } from "./CalendarViewModel"
import { Time } from "../date/Time.js"
import { client } from "../../misc/ClientDetector"
import { locator } from "../../api/main/MainLocator.js"
import { theme } from "../../gui/theme.js"
import { PageView } from "../../gui/base/PageView.js"

type CalendarMonthAttrs = {
	selectedDate: Date
	onDateSelected: (date: Date, calendarViewTypeToShow: CalendarViewType) => unknown
	eventsForDays: ReadonlyMap<number, Array<CalendarEvent>>
	getEventsOnDaysToRender: (range: Array<Date>) => EventsOnDays
	onNewEvent: (date: Date | null) => unknown
	onEventClicked: CalendarEventBubbleClickHandler
	onChangeMonth: (next: boolean) => unknown
	amPmFormat: boolean
	startOfTheWeek: WeekStart
	groupColors: GroupColors
	hiddenCalendars: ReadonlySet<Id>
	temporaryEvents: Array<CalendarEvent>
	dragHandlerCallbacks: EventDragHandlerCallbacks
}
type SimplePosRect = {
	top: number
	left: number
	right: number
}

/** height of the day number indicator at the top of the day square */
const dayHeight = () => (styles.isDesktopLayout() ? 32 : 24)

const spaceBetweenEvents = () => (styles.isDesktopLayout() ? 2 : 1)

const EVENT_BUBBLE_VERTICAL_OFFSET = 5

export class CalendarMonthView implements Component<CalendarMonthAttrs>, ClassComponent<CalendarMonthAttrs> {
	private _monthDom: HTMLElement | null = null
	private _resizeListener: () => unknown
	private _zone: string
	private _lastWidth: number
	private _lastHeight: number
	private _eventDragHandler: EventDragHandler
	private _dayUnderMouse: Date | null = null
	private _lastMousePos: MousePos | null = null

	constructor({ attrs }: Vnode<CalendarMonthAttrs>) {
		this._resizeListener = m.redraw
		this._zone = getTimeZone()
		this._lastWidth = 0
		this._lastHeight = 0
		this._eventDragHandler = new EventDragHandler(neverNull(document.body as HTMLBodyElement), attrs.dragHandlerCallbacks)
	}

	oncreate() {
		windowFacade.addResizeListener(this._resizeListener)
	}

	onremove() {
		windowFacade.removeResizeListener(this._resizeListener)
	}

	view({ attrs }: Vnode<CalendarMonthAttrs>): Children {
		const startOfTheWeekOffset = getStartOfTheWeekOffset(attrs.startOfTheWeek)
		const thisMonth = getCalendarMonth(attrs.selectedDate, startOfTheWeekOffset, styles.isSingleColumnLayout())
		const lastMonthDate = incrementMonth(attrs.selectedDate, -1)
		const nextMonthDate = incrementMonth(attrs.selectedDate, 1)
		const previousMonth = getCalendarMonth(lastMonthDate, startOfTheWeekOffset, styles.isSingleColumnLayout())
		const nextMonth = getCalendarMonth(nextMonthDate, startOfTheWeekOffset, styles.isSingleColumnLayout())

		let containerStyle

		if (styles.isDesktopLayout()) {
			containerStyle = {
				marginLeft: "5px",
				overflow: "hidden",
				marginBottom: px(size.hpad_large),
			}
		} else {
			containerStyle = {}
		}

		return m(
			".fill-absolute.flex.col",
			{
				style: containerStyle,
				class:
					(!styles.isUsingBottomNavigation() ? "content-bg" : "") +
					(styles.isDesktopLayout() ? " mlr-l border-radius-big" : " mlr-safe-inset border-radius-top-left-big border-radius-top-right-big"),
			},
			[
				m(
					".flex.mb-s.pt-s",
					thisMonth.weekdays.map((wd) => m(".flex-grow", m(".calendar-day-indicator.b", wd))),
				),
				m(
					".rel.flex-grow",
					m(PageView, {
						previousPage: {
							key: getFirstDayOfMonth(lastMonthDate).getTime(),
							nodes: this._monthDom ? this._renderCalendar(attrs, previousMonth, thisMonth, this._zone) : null,
						},
						currentPage: {
							key: getFirstDayOfMonth(attrs.selectedDate).getTime(),
							nodes: this._renderCalendar(attrs, thisMonth, thisMonth, this._zone),
						},
						nextPage: {
							key: getFirstDayOfMonth(nextMonthDate).getTime(),
							nodes: this._monthDom ? this._renderCalendar(attrs, nextMonth, thisMonth, this._zone) : null,
						},
						onChangePage: (next) => attrs.onChangeMonth(next),
					}),
				),
			],
		)
	}

	onbeforeupdate(newVnode: Vnode<CalendarMonthAttrs>, oldVnode: VnodeDOM<CalendarMonthAttrs>): boolean {
		const dom = this._monthDom
		const different =
			!dom ||
			oldVnode.attrs.eventsForDays !== newVnode.attrs.eventsForDays ||
			oldVnode.attrs.selectedDate !== newVnode.attrs.selectedDate ||
			oldVnode.attrs.amPmFormat !== newVnode.attrs.amPmFormat ||
			oldVnode.attrs.groupColors !== newVnode.attrs.groupColors ||
			oldVnode.attrs.hiddenCalendars !== newVnode.attrs.hiddenCalendars ||
			dom.offsetWidth !== this._lastWidth ||
			dom.offsetHeight !== this._lastHeight

		if (dom) {
			this._lastWidth = dom.offsetWidth
			this._lastHeight = dom.offsetHeight
		}

		return different || this._eventDragHandler.queryHasChanged()
	}

	_renderCalendar(attrs: CalendarMonthAttrs, month: CalendarMonth, currentlyVisibleMonth: CalendarMonth, zone: string): Children {
		const { weeks } = month
		const today = getStartOfDayWithZone(new Date(), getTimeZone())
		return m(
			".fill-absolute.flex.col.flex-grow",
			{
				oncreate: (vnode) => {
					if (month === currentlyVisibleMonth) {
						this._monthDom = vnode.dom as HTMLElement
						m.redraw()
					}
				},
				onupdate: (vnode) => {
					if (month === currentlyVisibleMonth) {
						this._monthDom = vnode.dom as HTMLElement
					}
				},
				onmousemove: (mouseEvent: MouseEvent & { redraw?: boolean }) => {
					mouseEvent.redraw = false
					const posAndBoundsFromMouseEvent = getPosAndBoundsFromMouseEvent(mouseEvent)
					this._lastMousePos = posAndBoundsFromMouseEvent
					this._dayUnderMouse = getDateFromMousePos(
						posAndBoundsFromMouseEvent,
						weeks.map((week) => week.map((day) => day.date)),
					)

					this._eventDragHandler.handleDrag(this._dayUnderMouse, posAndBoundsFromMouseEvent)
				},
				onmouseup: (mouseEvent: MouseEvent & { redraw?: boolean }) => {
					mouseEvent.redraw = false

					this._endDrag(mouseEvent)
				},
				onmouseleave: (mouseEvent: MouseEvent & { redraw?: boolean }) => {
					mouseEvent.redraw = false

					this._endDrag(mouseEvent)
				},
			},
			weeks.map((week, weekIndex) => {
				return m(
					".flex.flex-grow.rel",
					{
						key: week[0].date.getTime(),
					},
					[
						week.map((day, i) => this._renderDay(attrs, day, today, i, weekIndex === 0)),
						this._monthDom ? this._renderWeekEvents(attrs, week, zone) : null,
					],
				)
			}),
		)
	}

	_endDrag(pos: MousePos) {
		const dayUnderMouse = this._dayUnderMouse
		const originalDate = this._eventDragHandler.originalEvent?.startTime

		if (dayUnderMouse && originalDate) {
			//make sure the date we move to also gets a time
			const dateUnderMouse = Time.fromDate(originalDate).toDate(dayUnderMouse)

			this._eventDragHandler.endDrag(dateUnderMouse, pos).catch(ofClass(UserError, showUserError))
		}
	}

	/** render the grid of days */
	_renderDay(attrs: CalendarMonthAttrs, day: CalendarDay, today: Date, weekDayNumber: number, firstWeek: boolean): Children {
		const { selectedDate } = attrs
		return m(
			".calendar-day.calendar-column-border.flex-grow.rel.overflow-hidden.fill-absolute.cursor-pointer",
			{
				style: {
					...(firstWeek && !styles.isDesktopLayout() ? { borderTop: "none" } : {}),
				},
				key: day.date.getTime(),
				onclick: (e: MouseEvent) => {
					if (client.isDesktopDevice()) {
						const newDate = new Date(day.date)
						let hour = new Date().getHours()

						if (hour < 23) {
							hour++
						}

						newDate.setHours(hour, 0)
						attrs.onDateSelected(new Date(day.date), CalendarViewType.MONTH)
						attrs.onNewEvent(newDate)
					} else {
						attrs.onDateSelected(new Date(day.date), styles.isDesktopLayout() ? CalendarViewType.DAY : CalendarViewType.AGENDA)
					}

					e.preventDefault()
				},
			},
			[
				m(".mb-xs", {
					style: {
						height: px(SELECTED_DATE_INDICATOR_THICKNESS),
					},
				}),
				this._renderDayHeader(day, today, attrs.onDateSelected), // According to ISO 8601, weeks always start on Monday. Week numbering systems for
				// weeks that do not start on Monday are not strictly defined, so we only display
				// a week number if the user's client is configured to start weeks on Monday
				weekDayNumber === 0 && attrs.startOfTheWeek === WeekStart.MONDAY ? m(".calendar-month-week-number.abs", getWeekNumber(day.date)) : null,
			],
		)
	}

	_renderDayHeader(
		{ date, day, isPaddingDay }: CalendarDay,
		today: Date,
		onDateSelected: (date: Date, calendarViewTypeToShow: CalendarViewType) => unknown,
	): Children {
		let circleStyle
		let textStyle
		if (isToday(date)) {
			circleStyle = {
				backgroundColor: theme.content_button,
				opacity: "0.25",
			}
			textStyle = {
				fontWeight: "bold",
			}
		} else {
			circleStyle = {}
			textStyle = {}
		}

		const size = styles.isDesktopLayout() ? px(22) : px(20)
		return m(
			".rel.click.flex.items-center.justify-center.rel.ml-hpad_small",
			{
				"aria-label": date.toLocaleDateString(),
				onclick: (e: MouseEvent) => {
					onDateSelected(new Date(date), client.isDesktopDevice() || styles.isDesktopLayout() ? CalendarViewType.DAY : CalendarViewType.AGENDA)
					e.stopPropagation()
				},
			},
			[
				m(".abs.z1.circle", {
					style: {
						...circleStyle,
						width: size,
						height: size,
					},
				}),
				m(
					".full-width.height-100p.center.z2",
					{
						style: {
							...textStyle,
							opacity: isPaddingDay ? 0.4 : 1,
							fontWeight: isPaddingDay ? "500" : null,
							fontSize: styles.isDesktopLayout() ? "14px" : "12px",
							lineHeight: size,
						},
					},
					String(day),
				),
			],
		)
	}

	/** render the events for the given week */
	_renderWeekEvents(attrs: CalendarMonthAttrs, week: ReadonlyArray<CalendarDay>, zone: string): Children {
		const eventsOnDays = attrs.getEventsOnDaysToRender(week.map((day) => day.date))
		const events = new Set(eventsOnDays.longEvents.concat(eventsOnDays.shortEvents.flat()))
		const firstDayOfWeek = week[0].date
		const lastDayOfWeek = lastThrow(week)

		const dayWidth = this._getWidthForDay()

		const weekHeight = this._getHeightForWeek()

		const eventHeight = size.calendar_line_height + spaceBetweenEvents() // height + border

		const maxEventsPerDay = (weekHeight - dayHeight()) / eventHeight
		const numberOfEventsPerDayToRender = Math.floor(maxEventsPerDay) - 1 // preserve some space for the more events indicator

		/** initially, we have 0 extra, non-rendered events on each day of the week */
		const moreEventsForDay = [0, 0, 0, 0, 0, 0, 0]
		const eventMargin = styles.isDesktopLayout() ? size.calendar_event_margin : size.calendar_event_margin_mobile
		const firstDayOfNextWeek = getStartOfNextDayWithZone(lastDayOfWeek.date, zone)
		return layOutEvents(
			Array.from(events),
			zone,
			(columns) => {
				return columns
					.map((eventsInColumn, columnIndex) => {
						return eventsInColumn.map((event) => {
							if (columnIndex < numberOfEventsPerDayToRender) {
								const eventIsAllDay = isAllDayEventByTimes(event.startTime, event.endTime)
								const eventStart = eventIsAllDay ? getAllDayDateForTimezone(event.startTime, zone) : event.startTime
								const eventEnd = eventIsAllDay ? incrementDate(getEventEnd(event, zone), -1) : event.endTime

								const position = this._getEventPosition(
									eventStart,
									eventEnd,
									firstDayOfWeek,
									firstDayOfNextWeek,
									dayWidth,
									dayHeight(),
									columnIndex,
								)
								return this.renderEvent(event, position, eventStart, firstDayOfWeek, firstDayOfNextWeek, eventEnd, attrs)
							} else {
								for (const [dayIndex, dayInWeek] of week.entries()) {
									const eventsForDay = attrs.eventsForDays.get(dayInWeek.date.getTime())

									if (eventsForDay && eventsForDay.indexOf(event) !== -1) {
										moreEventsForDay[dayIndex]++
									}
								}
								return null
							}
						})
					})
					.concat(
						moreEventsForDay.map((moreEventsCount, weekday) => {
							const day = week[weekday]
							const isPadding = day.isPaddingDay

							if (moreEventsCount > 0) {
								return m(
									".abs.small" + (isPadding ? ".calendar-bubble-more-padding-day" : ""),
									{
										style: {
											bottom: 0,
											height: px(CALENDAR_EVENT_HEIGHT),
											left: px(weekday * dayWidth + eventMargin),
											width: px(dayWidth - 2 - eventMargin * 2),
											pointerEvents: "none",
										},
									},
									m(
										"",
										{
											style: {
												"font-weight": "600",
											},
										},
										"+" + moreEventsCount,
									),
								)
							} else {
								return null
							}
						}),
					)
			},
			EventLayoutMode.DayBasedColumn,
		)
	}

	renderEvent(
		event: CalendarEvent,
		position: SimplePosRect,
		eventStart: Date,
		firstDayOfWeek: Date,
		firstDayOfNextWeek: Date,
		eventEnd: Date,
		attrs: CalendarMonthAttrs,
	): Children {
		const isTemporary = attrs.temporaryEvents.includes(event)
		return m(
			".abs.overflow-hidden",
			{
				key: event._id[0] + event._id[1] + event.startTime.getTime(),
				style: {
					top: px(position.top),
					height: px(CALENDAR_EVENT_HEIGHT),
					left: px(position.left),
					right: px(position.right),
					pointerEvents: !styles.isUsingBottomNavigation() ? "auto" : "none",
				},
				onmousedown: () => {
					let dayUnderMouse = this._dayUnderMouse
					let lastMousePos = this._lastMousePos

					if (dayUnderMouse && lastMousePos && !isTemporary) {
						this._eventDragHandler.prepareDrag(event, dayUnderMouse, lastMousePos, true)
					}
				},
			},
			m(ContinuingCalendarEventBubble, {
				event: event,
				startsBefore: eventStart < firstDayOfWeek,
				endsAfter: firstDayOfNextWeek < eventEnd,
				color: getEventColor(event, attrs.groupColors),
				showTime: styles.isDesktopLayout() && !isAllDayEvent(event) ? EventTextTimeOption.START_TIME : null,
				user: locator.logins.getUserController().user,
				onEventClicked: (e, domEvent) => {
					attrs.onEventClicked(event, domEvent)
				},
				fadeIn: !this._eventDragHandler.isDragging,
				opacity: isTemporary ? TEMPORARY_EVENT_OPACITY : 1,
				enablePointerEvents: !this._eventDragHandler.isDragging && !isTemporary && client.isDesktopDevice(),
			}),
		)
	}

	_getEventPosition(
		eventStart: Date,
		eventEnd: Date,
		firstDayOfWeek: Date,
		firstDayOfNextWeek: Date,
		calendarDayWidth: number,
		calendarDayHeight: number,
		columnIndex: number,
	): SimplePosRect {
		const top = (size.calendar_line_height + spaceBetweenEvents()) * columnIndex + calendarDayHeight + EVENT_BUBBLE_VERTICAL_OFFSET
		const dayOfStartDateInWeek = getDiffIn24IntervalsFast(eventStart, firstDayOfWeek)
		const dayOfEndDateInWeek = getDiffIn24IntervalsFast(eventEnd, firstDayOfWeek)
		const calendarEventMargin = styles.isDesktopLayout() ? size.calendar_event_margin : size.calendar_event_margin_mobile
		const left = (eventStart < firstDayOfWeek ? 0 : dayOfStartDateInWeek * calendarDayWidth) + calendarEventMargin
		const right = (eventEnd > firstDayOfNextWeek ? 0 : (6 - dayOfEndDateInWeek) * calendarDayWidth) + calendarEventMargin
		return {
			top,
			left,
			right,
		}
	}

	_getHeightForWeek(): number {
		if (!this._monthDom) {
			return 1
		}

		const monthDomHeight = this._monthDom.offsetHeight
		return monthDomHeight / 6
	}

	_getWidthForDay(): number {
		if (!this._monthDom) {
			return 1
		}

		const monthDomWidth = this._monthDom.offsetWidth
		return monthDomWidth / 7
	}
}

/**
 * Optimization to not create luxon's DateTime in simple case.
 * May not work if we allow override time zones.
 */
function getDiffIn24IntervalsFast(left: Date, right: Date): number {
	if (left.getMonth() === right.getMonth()) {
		return left.getDate() - right.getDate()
	} else {
		return getDiffIn24hIntervals(right, left)
	}
}
