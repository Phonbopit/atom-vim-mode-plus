"use babel"

const _ = require("underscore-plus")
const {Range} = require("atom")

const {moveCursorLeft, moveCursorRight, limitNumber, isEmptyRow, setBufferRow} = require("./utils")
const Operator = require("./base").getClass("Operator")

// Operator which start 'insert-mode'
// -------------------------
// [NOTE]
// Rule: Don't make any text mutation before calling `@selectTarget()`.
class ActivateInsertMode extends Operator {
  static initClass() {
    this.extend()
    this.prototype.requireTarget = false
    this.prototype.flashTarget = false
    this.prototype.finalSubmode = null
    this.prototype.supportInsertionCount = true
  }

  observeWillDeactivateMode() {
    let disposable = this.vimState.modeManager.preemptWillDeactivateMode(({mode}) => {
      if (mode !== "insert") return
      disposable.dispose()

      this.vimState.mark.set("^", this.editor.getCursorBufferPosition()) // Last insert-mode position
      let textByUserInput = ""
      const change = this.getChangeSinceCheckpoint("insert")
      if (change) {
        this.lastChange = change
        this.setMarkForChange(new Range(change.start, change.start.traverse(change.newExtent)))
        textByUserInput = change.newText
      }
      this.vimState.register.set(".", {text: textByUserInput}) // Last inserted text

      _.times(this.getInsertionCount(), () => {
        const textToInsert = this.textByOperator + textByUserInput
        for (const selection of this.editor.getSelections()) {
          selection.insertText(textToInsert, {autoIndent: true})
        }
      })

      // This cursor state is restored on undo.
      // So cursor state has to be updated before next groupChangesSinceCheckpoint()
      if (this.getConfig("clearMultipleCursorsOnEscapeInsertMode")) {
        this.vimState.clearSelections()
      }

      // grouping changes for undo checkpoint need to come last
      if (this.getConfig("groupChangesWhenLeavingInsertMode")) {
        return this.groupChangesSinceBufferCheckpoint("undo")
      }
    })
  }

  // When each mutaion's extent is not intersecting, muitiple changes are recorded
  // e.g
  //  - Multicursors edit
  //  - Cursor moved in insert-mode(e.g ctrl-f, ctrl-b)
  // But I don't care multiple changes just because I'm lazy(so not perfect implementation).
  // I only take care of one change happened at earliest(topCursor's change) position.
  // Thats' why I save topCursor's position to @topCursorPositionAtInsertionStart to compare traversal to deletionStart
  // Why I use topCursor's change? Just because it's easy to use first change returned by getChangeSinceCheckpoint().
  getChangeSinceCheckpoint(purpose) {
    const checkpoint = this.getBufferCheckpoint(purpose)
    return this.editor.buffer.getChangesSinceCheckpoint(checkpoint)[0]
  }

  // [BUG-BUT-OK] Replaying text-deletion-operation is not compatible to pure Vim.
  // Pure Vim record all operation in insert-mode as keystroke level and can distinguish
  // character deleted by `Delete` or by `ctrl-u`.
  // But I can not and don't trying to minic this level of compatibility.
  // So basically deletion-done-in-one is expected to work well.
  replayLastChange(selection) {
    let textToInsert
    if (this.lastChange != null) {
      const {start, newExtent, oldExtent, newText} = this.lastChange
      if (!oldExtent.isZero()) {
        const traversalToStartOfDelete = start.traversalFrom(this.topCursorPositionAtInsertionStart)
        const deletionStart = selection.cursor.getBufferPosition().traverse(traversalToStartOfDelete)
        const deletionEnd = deletionStart.traverse(oldExtent)
        selection.setBufferRange([deletionStart, deletionEnd])
      }
      textToInsert = newText
    } else {
      textToInsert = ""
    }
    selection.insertText(textToInsert, {autoIndent: true})
  }

  // called when repeated
  // [FIXME] to use replayLastChange in repeatInsert overriding subclasss.
  repeatInsert(selection, text) {
    this.replayLastChange(selection)
  }

  getInsertionCount() {
    if (this.insertionCount == null) {
      this.insertionCount = this.supportInsertionCount ? this.getCount(-1) : 0
    }
    // Avoid freezing by acccidental big count(e.g. `5555555555555i`), See #560, #596
    return limitNumber(this.insertionCount, {max: 100})
  }

  execute() {
    if (this.repeated) {
      this.flashTarget = this.trackChange = true

      this.startMutation(() => {
        if (this.target) this.selectTarget()
        if (this.mutateText) this.mutateText()

        for (const selection of this.editor.getSelections()) {
          const textToInsert = (this.lastChange && this.lastChange.newText) || ""
          this.repeatInsert(selection, textToInsert)
          moveCursorLeft(selection.cursor)
        }
        this.vimState.mutationManager.setCheckpoint("did-finish")
      })

      if (this.getConfig("clearMultipleCursorsOnEscapeInsertMode")) this.vimState.clearSelections()
    } else {
      this.normalizeSelectionsIfNecessary()
      this.createBufferCheckpoint("undo")
      if (this.target) this.selectTarget()
      this.observeWillDeactivateMode()
      if (this.mutateText) this.mutateText()

      if (this.getInsertionCount() > 0) {
        const change = this.getChangeSinceCheckpoint("undo")
        this.textByOperator = (change && change.newText) || ""
      }

      this.createBufferCheckpoint("insert")
      const topCursor = this.editor.getCursorsOrderedByBufferPosition()[0]
      this.topCursorPositionAtInsertionStart = topCursor.getBufferPosition()

      // Skip normalization of blockwiseSelection.
      // Since want to keep multi-cursor and it's position in when shift to insert-mode.
      for (const blockwiseSelection of this.getBlockwiseSelections()) {
        blockwiseSelection.skipNormalization()
      }
      this.activateMode("insert", this.finalSubmode)
    }
  }
}
ActivateInsertMode.initClass()

class ActivateReplaceMode extends ActivateInsertMode {
  static initClass() {
    this.extend()
    this.prototype.finalSubmode = "replace"
  }

  repeatInsert(selection, text) {
    for (const char of text) {
      if (char === "\n") continue
      if (selection.cursor.isAtEndOfLine()) break
      selection.selectRight()
    }
    selection.insertText(text, {autoIndent: false})
  }
}
ActivateReplaceMode.initClass()

class InsertAfter extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }
  execute() {
    for (const cursor of this.editor.getCursors()) {
      moveCursorRight(cursor)
    }
    super.execute()
  }
}
InsertAfter.initClass()

// key: 'g I' in all mode
class InsertAtBeginningOfLine extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }
  execute() {
    if (this.mode === "visual" && this.submode !== "blockwise") {
      this.editor.splitSelectionsIntoLines()
    }
    this.editor.moveToBeginningOfLine()
    super.execute()
  }
}
InsertAtBeginningOfLine.initClass()

// key: normal 'A'
class InsertAfterEndOfLine extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }
  execute() {
    this.editor.moveToEndOfLine()
    super.execute()
  }
}
InsertAfterEndOfLine.initClass()

// key: normal 'I'
class InsertAtFirstCharacterOfLine extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }
  execute() {
    this.editor.moveToBeginningOfLine()
    this.editor.moveToFirstCharacterOfLine()
    super.execute()
  }
}
InsertAtFirstCharacterOfLine.initClass()

class InsertAtLastInsert extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }
  execute() {
    const point = this.vimState.mark.get("^")
    if (point) {
      this.editor.setCursorBufferPosition(point)
      this.editor.scrollToCursorPosition({center: true})
    }
    super.execute()
  }
}
InsertAtLastInsert.initClass()

class InsertAboveWithNewline extends ActivateInsertMode {
  static initClass() {
    this.extend()
  }

  constructor (...args) {
    super(...args)
    if (this.getConfig("groupChangesWhenLeavingInsertMode")) {
      this.originalCursorPositionMarker = this.editor.markBufferPosition(this.editor.getCursorBufferPosition())
    }
  }

  // This is for `o` and `O` operator.
  // On undo/redo put cursor at original point where user type `o` or `O`.
  groupChangesSinceBufferCheckpoint(purpose) {
    const lastCursor = this.editor.getLastCursor()
    const cursorPosition = lastCursor.getBufferPosition()
    lastCursor.setBufferPosition(this.originalCursorPositionMarker.getHeadBufferPosition())
    this.originalCursorPositionMarker.destroy()

    super.groupChangesSinceBufferCheckpoint(purpose)

    lastCursor.setBufferPosition(cursorPosition)
  }

  autoIndentEmptyRows() {
    for (const cursor of this.editor.getCursors()) {
      const row = cursor.getBufferRow()
      if (isEmptyRow(this.editor, row)) {
        this.editor.autoIndentBufferRow(row)
      }
    }
  }

  mutateText() {
    this.editor.insertNewlineAbove()
    if (this.editor.autoIndent) {
      this.autoIndentEmptyRows()
    }
  }

  repeatInsert(selection, text) {
    selection.insertText(text.trimLeft(), {autoIndent: true})
  }
}
InsertAboveWithNewline.initClass()

class InsertBelowWithNewline extends InsertAboveWithNewline {
  static initClass() {
    this.extend()
  }
  mutateText() {
    for (const cursor of this.editor.getCursors()) {
      const row = cursor.getBufferRow()
      setBufferRow(cursor, this.getFoldEndRowForRow(row))
    }

    this.editor.insertNewlineBelow()
    if (this.editor.autoIndent) this.autoIndentEmptyRows()
  }
}
InsertBelowWithNewline.initClass()

// Advanced Insertion
// -------------------------
class InsertByTarget extends ActivateInsertMode {
  static initClass() {
    this.extend(false)
    this.prototype.requireTarget = true
    this.prototype.which = null // one of ['start', 'end', 'head', 'tail']
  }

  constructor (...args) {
    super(...args)
    // HACK
    // When g i is mapped to `insert-at-start-of-target`.
    // `g i 3 l` start insert at 3 column right position.
    // In this case, we don't want repeat insertion 3 times.
    // This @getCount() call cache number at the timing BEFORE '3' is specified.
    this.getCount()
  }

  execute() {
    this.onDidSelectTarget(() => {
      // In vC/vL, when occurrence marker was NOT selected,
      // it behave's very specially
      // vC: `I` and `A` behaves as shoft hand of `ctrl-v I` and `ctrl-v A`.
      // vL: `I` and `A` place cursors at each selected lines of start( or end ) of non-white-space char.
      if (!this.occurrenceSelected && this.mode === "visual" && this.submode !== "blockwise") {
        for (const $selection of this.swrap.getSelections(this.editor)) {
          $selection.normalize()
          $selection.applyWise("blockwise")
        }

        if (this.submode === "linewise") {
          for (const blockwiseSelection of this.getBlockwiseSelections()) {
            blockwiseSelection.expandMemberSelectionsOverLineWithTrimRange()
          }
        }
      }

      for (const $selection of this.swrap.getSelections(this.editor)) {
        $selection.setBufferPositionTo(this.which)
      }
    })
    super.execute()
  }
}
InsertByTarget.initClass()

// key: 'I', Used in 'visual-mode.characterwise', visual-mode.blockwise
class InsertAtStartOfTarget extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "start"
  }
}
InsertAtStartOfTarget.initClass()

// key: 'A', Used in 'visual-mode.characterwise', 'visual-mode.blockwise'
class InsertAtEndOfTarget extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "end"
  }
}
InsertAtEndOfTarget.initClass()

class InsertAtHeadOfTarget extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "head"
  }
}
InsertAtHeadOfTarget.initClass()

class InsertAtStartOfOccurrence extends InsertAtStartOfTarget {
  static initClass() {
    this.extend()
    this.prototype.occurrence = true
  }
}
InsertAtStartOfOccurrence.initClass()

class InsertAtEndOfOccurrence extends InsertAtEndOfTarget {
  static initClass() {
    this.extend()
    this.prototype.occurrence = true
  }
}
InsertAtEndOfOccurrence.initClass()

class InsertAtHeadOfOccurrence extends InsertAtHeadOfTarget {
  static initClass() {
    this.extend()
    this.prototype.occurrence = true
  }
}
InsertAtHeadOfOccurrence.initClass()

class InsertAtStartOfSubwordOccurrence extends InsertAtStartOfOccurrence {
  static initClass() {
    this.extend()
    this.prototype.occurrenceType = "subword"
  }
}
InsertAtStartOfSubwordOccurrence.initClass()

class InsertAtEndOfSubwordOccurrence extends InsertAtEndOfOccurrence {
  static initClass() {
    this.extend()
    this.prototype.occurrenceType = "subword"
  }
}
InsertAtEndOfSubwordOccurrence.initClass()

class InsertAtHeadOfSubwordOccurrence extends InsertAtHeadOfOccurrence {
  static initClass() {
    this.extend()
    this.prototype.occurrenceType = "subword"
  }
}
InsertAtHeadOfSubwordOccurrence.initClass()

class InsertAtStartOfSmartWord extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "start"
    this.prototype.target = "MoveToPreviousSmartWord"
  }
}
InsertAtStartOfSmartWord.initClass()

class InsertAtEndOfSmartWord extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "end"
    this.prototype.target = "MoveToEndOfSmartWord"
  }
}
InsertAtEndOfSmartWord.initClass()

class InsertAtPreviousFoldStart extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "start"
    this.prototype.target = "MoveToPreviousFoldStart"
  }
}
InsertAtPreviousFoldStart.initClass()

class InsertAtNextFoldStart extends InsertByTarget {
  static initClass() {
    this.extend()
    this.prototype.which = "end"
    this.prototype.target = "MoveToNextFoldStart"
  }
}
InsertAtNextFoldStart.initClass()

// -------------------------
class Change extends ActivateInsertMode {
  static initClass() {
    this.extend()
    this.prototype.requireTarget = true
    this.prototype.trackChange = true
    this.prototype.supportInsertionCount = false
  }

  mutateText() {
    // Allways dynamically determine selection wise wthout consulting target.wise
    // Reason: when `c i {`, wise is 'characterwise', but actually selected range is 'linewise'
    //   {
    //     a
    //   }
    const isLinewiseTarget = this.swrap.detectWise(this.editor) === "linewise"
    for (const selection of this.editor.getSelections()) {
      if (!this.getConfig("dontUpdateRegisterOnChangeOrSubstitute")) {
        this.setTextToRegisterForSelection(selection)
      }
      if (isLinewiseTarget) {
        selection.insertText("\n", {autoIndent: true})
        selection.cursor.moveLeft()
      } else {
        selection.insertText("", {autoIndent: true})
      }
    }
  }
}
Change.initClass()

class ChangeOccurrence extends Change {
  static initClass() {
    this.extend()
    this.prototype.occurrence = true
  }
}
ChangeOccurrence.initClass()

class Substitute extends Change {
  static initClass() {
    this.extend()
    this.prototype.target = "MoveRight"
  }
}
Substitute.initClass()

class SubstituteLine extends Change {
  static initClass() {
    this.extend()
    this.prototype.wise = "linewise" // [FIXME] to re-override target.wise in visual-mode
    this.prototype.target = "MoveToRelativeLine"
  }
}
SubstituteLine.initClass()

// alias
class ChangeLine extends SubstituteLine {
  static initClass() {
    this.extend()
  }
}
ChangeLine.initClass()

class ChangeToLastCharacterOfLine extends Change {
  static initClass() {
    this.extend()
    this.prototype.target = "MoveToLastCharacterOfLine"
  }

  execute() {
    this.onDidSelectTarget(() => {
      if (this.target.wise === "blockwise") {
        for (const blockwiseSelection of this.getBlockwiseSelections()) {
          blockwiseSelection.extendMemberSelectionsToEndOfLine()
        }
      }
    })
    super.execute()
  }
}
ChangeToLastCharacterOfLine.initClass()