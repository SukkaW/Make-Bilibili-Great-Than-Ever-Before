class ListNode {
  public next: ListNode | null = null;
  public prev: ListNode | null = null;

  constructor(public timestamp: number) { }
}

export class ErrorCounter {
  private head: ListNode | null = null;
  private tail: ListNode | null = null;
  private readonly intervalId: number;
  private $size = 0;

  constructor(private readonly timeWindow = 10000) {
    this.intervalId = self.setInterval(() => this.cleanup(), 1000);
  }

  recordError() {
    const now = Date.now();
    const newNode = new ListNode(now);

    if (this.tail) {
      this.tail.next = newNode;
      newNode.prev = this.tail;
      this.tail = newNode;
    } else {
      this.head = newNode;
      this.tail = newNode;
    }

    this.$size++;
  }

  getErrorCount(): number {
    this.cleanup();

    return this.$size;
    // let count = 0;
    // let current = this.head;
    // while (current) {
    //   count++;
    //   current = current.next;
    // }
    // return count;
  }

  private cleanup() {
    const now = Date.now();
    while (this.head && now - this.head.timestamp > this.timeWindow) {
      this.head = this.head.next;
      if (this.head) {
        this.head.prev = null;
      } else {
        this.tail = null;
      }
      this.$size--;
    }
  }

  stop() {
    clearInterval(this.intervalId);
  }
}
